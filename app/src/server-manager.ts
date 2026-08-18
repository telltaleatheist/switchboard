import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

export interface ServerManagerOptions {
  /** Absolute path to server/dist/index.js. */
  serverEntryPath: string;
  /**
   * `app.isPackaged`. Passed in rather than read from Electron so this module
   * stays Electron-free (and unit-testable): it only changes *how* the child
   * is launched, never what it is.
   */
  packaged: boolean;
  port: number;
  host: string;
  dataDir: string;
  /** Every stderr line from the child, forwarded for logging. */
  onStderrLine: (line: string) => void;
  /**
   * Called when the server process exits unexpectedly *after* having
   * reached ready — i.e. a crash, not a requested shutdown. Never called
   * more than once per crash, and never followed by an automatic restart:
   * that decision belongs to whoever is watching for this callback.
   */
  onCrash: (message: string) => void;
}

export interface ServerReadyInfo {
  port: number;
  operatorToken: string;
}

type ServerState =
  | { status: 'starting' }
  | { status: 'ready'; port: number; operatorToken: string }
  | { status: 'stopping' }
  | { status: 'stopped' }
  | { status: 'crashed'; message: string };

const READY_LINE_SHAPE_HINT =
  'expected a line like {"ready":true,"port":4400,"operatorToken":"sw_o_..."}';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a stdout line as the server's one-line ready announcement, or returns null. */
function tryParseReadyLine(line: string): ServerReadyInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['ready'] === true &&
    typeof (value as Record<string, unknown>)['port'] === 'number' &&
    typeof (value as Record<string, unknown>)['operatorToken'] === 'string'
  ) {
    const record = value as Record<string, unknown>;
    return { port: record['port'] as number, operatorToken: record['operatorToken'] as string };
  }

  return null;
}

interface ServerLauncher {
  /** Executable to spawn. */
  command: string;
  /** Environment for the child; undefined means "inherit this process's". */
  env: NodeJS.ProcessEnv | undefined;
}

/**
 * How the server child is launched, in both modes. The argv is identical
 * either way — the CLI contract in ARCHITECTURE.md never changes:
 *   <node-ish> server/dist/index.js --port P --host H --data-dir D
 *
 * - **Dev**: a `node` binary on PATH (the developer's Node 20).
 * - **Packaged**: there is no system `node` to assume, so the Electron binary
 *   is re-executed as plain Node via ELECTRON_RUN_AS_NODE=1 — no Chromium, no
 *   window, just Node with Electron's own V8/Node build.
 *   https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node
 *
 * The packaged server code and its node_modules ship as extraResources
 * (resources/server/, OUTSIDE the asar) because native `.node` files cannot be
 * loaded from an asar archive, and better-sqlite3 there is compiled against
 * Electron's Node ABI — see scripts/prepare-server-runtime.js.
 */
function resolveServerLauncher(packaged: boolean): ServerLauncher {
  if (packaged) {
    return {
      command: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: 'node', env: undefined };
}

/**
 * Owns the lifecycle of the switchboard server child process: spawn,
 * ready-detection, stderr forwarding, graceful shutdown, and crash
 * detection. One instance per app run.
 */
export class ServerManager {
  private readonly opts: ServerManagerOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: ServerState = { status: 'starting' };
  private shuttingDown = false;

  constructor(opts: ServerManagerOptions) {
    this.opts = opts;
  }

  getState(): ServerState {
    return this.state;
  }

  /**
   * Spawns the server and resolves once its ready line has been read from
   * stdout. Rejects (never resolves) if the process fails to spawn or exits
   * before printing a ready line — the caller is expected to fail loudly
   * (error dialog), never retry silently.
   */
  start(): Promise<ServerReadyInfo> {
    return new Promise<ServerReadyInfo>((resolve, reject) => {
      const args = [
        this.opts.serverEntryPath,
        '--port',
        String(this.opts.port),
        '--host',
        this.opts.host,
        '--data-dir',
        this.opts.dataDir,
      ];

      const launcher = resolveServerLauncher(this.opts.packaged);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(launcher.command, args, { windowsHide: true, env: launcher.env });
      } catch (err) {
        reject(new Error(`Failed to spawn switchboard server process: ${(err as Error).message}`));
        return;
      }
      this.child = child;

      let readyResolved = false;
      const stderrTail: string[] = [];
      const pushStderrTail = (line: string): void => {
        stderrTail.push(line);
        if (stderrTail.length > 50) stderrTail.shift();
      };

      const stdoutReader = readline.createInterface({ input: child.stdout });
      stdoutReader.on('line', (line) => {
        if (readyResolved) {
          // Contract is exactly one JSON ready line; anything after that is
          // unexpected but not fatal — surface it rather than swallow it.
          console.log('[switchboard-server:stdout]', line);
          return;
        }
        const ready = tryParseReadyLine(line);
        if (ready) {
          readyResolved = true;
          this.state = { status: 'ready', port: ready.port, operatorToken: ready.operatorToken };
          resolve(ready);
        } else {
          console.log('[switchboard-server:stdout]', line);
        }
      });

      const stderrReader = readline.createInterface({ input: child.stderr });
      stderrReader.on('line', (line) => {
        pushStderrTail(line);
        this.opts.onStderrLine(line);
      });

      child.once('error', (err) => {
        if (!readyResolved) {
          reject(new Error(`Switchboard server process could not be started: ${err.message}`));
          return;
        }
        if (!this.shuttingDown) {
          const message = `Switchboard server process error: ${err.message}`;
          this.state = { status: 'crashed', message };
          this.opts.onCrash(message);
        }
      });

      child.once('exit', (code, signal) => {
        this.child = null;

        if (this.shuttingDown) {
          // Expected exit as part of shutdown(); that method has its own
          // 'exit' listener to unblock its wait. Nothing more to do here.
          return;
        }

        const detail =
          `exit code=${code ?? 'null'} signal=${signal ?? 'null'}` +
          (stderrTail.length ? `\n--- last server stderr ---\n${stderrTail.join('\n')}` : '');

        if (!readyResolved) {
          reject(
            new Error(
              `Switchboard server exited before it became ready (${detail}). ${READY_LINE_SHAPE_HINT}`
            )
          );
          return;
        }

        const message = `Switchboard server exited unexpectedly (${detail})`;
        this.state = { status: 'crashed', message };
        this.opts.onCrash(message);
      });
    });
  }

  /**
   * Graceful shutdown per ARCHITECTURE.md: write {"cmd":"shutdown"}\n to the
   * child's stdin, wait up to `timeoutMs` for it to exit on its own, then
   * kill it. Always resolves (never throws) once the process is confirmed
   * gone or a best-effort kill has been issued — the caller (app quit path)
   * must never be blocked indefinitely by a misbehaving child.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.state = { status: 'stopped' };
      return;
    }

    this.shuttingDown = true;
    this.state = { status: 'stopping' };

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    try {
      child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
    } catch (err) {
      // stdin may already be closed/broken; fall through to the timeout and
      // hard-kill below rather than hanging or throwing.
      console.error('[switchboard-app] failed to write shutdown command to server stdin:', err);
    }

    const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);

    if (timedOut) {
      console.error(
        `[switchboard-app] server did not exit within ${timeoutMs}ms of the shutdown command; killing it`
      );
      child.kill();
      // Best-effort: give the OS a moment to reap the process, but never
      // block quit indefinitely on it.
      await Promise.race([exited, delay(2000)]);
    }

    this.child = null;
    this.state = { status: 'stopped' };
  }
}
