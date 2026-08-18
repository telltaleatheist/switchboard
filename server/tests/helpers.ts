/**
 * Test harness: spawns a REAL server process on an ephemeral port with a temp
 * data dir, exactly as the Electron app would, and gives tests thin fetch/WS
 * helpers. Zero dependencies beyond the server's own (`ws`).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const ENTRY = path.resolve(__dirname, '..', 'src', 'index.js');

export interface Harness {
  port: number;
  operatorToken: string;
  dataDir: string;
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
  exited: Promise<number | null>;
  /** Graceful stop via the stdin protocol; resolves with the exit code. */
  stop(): Promise<number | null>;
  /** Kill this specific child (only used if a test failed mid-flight). */
  kill(): void;
  cleanup(): void;
}

export interface StartOptions {
  dataDir?: string;
  idleDays?: number;
  keepDataDir?: boolean;
}

export function tempDataDir(): string {
  return path.join(os.tmpdir(), `switchboard-test-${randomBytes(6).toString('hex')}`);
}

export async function startServer(options: StartOptions = {}): Promise<Harness> {
  const dataDir = options.dataDir ?? tempDataDir();
  const args = [ENTRY, '--port', '0', '--host', '127.0.0.1', '--data-dir', dataDir];
  if (options.idleDays !== undefined) args.push('--idle-days', String(options.idleDays));

  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line.trim().length > 0) stderr.push(line.trim());
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const ready = await new Promise<{ ready: boolean; port: number; operatorToken: string }>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`server did not print a ready line; stderr:\n${stderr.join('\n')}`)), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line) as { ready: boolean; port: number; operatorToken: string });
      } catch (err) {
        reject(new Error(`ready line was not JSON: ${line}`));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before ready; stderr:\n${stderr.join('\n')}`));
    });
  });

  const harness: Harness = {
    port: ready.port,
    operatorToken: ready.operatorToken,
    dataDir,
    child,
    stderr,
    exited,
    stop: async () => {
      if (child.exitCode !== null) return child.exitCode;
      child.stdin.write('{"cmd":"shutdown"}\n');
      return await exited;
    },
    kill: () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
    cleanup: () => {
      if (options.keepDataDir === true) return;
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* the OS may still hold the WAL briefly on Windows; temp dir, harmless */
      }
    },
  };
  return harness;
}

// --------------------------------------------------------------- HTTP calls

export interface ApiResponse<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  rawBody?: Uint8Array | string;
  headers?: Record<string, string>;
}

export async function call<T = any>(
  h: Harness,
  method: string,
  urlPath: string,
  options: CallOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  let body: string | Uint8Array | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${h.port}${urlPath}`, { method, headers, body: body as never });
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`response for ${method} ${urlPath} was not JSON: ${text.slice(0, 400)}`);
    }
  }
  return { status: res.status, json: json as T, headers: res.headers };
}

// ----------------------------------------------------------------- WS calls

/** A WebSocket that records frames and lets a test await the next one. */
export class FrameLog {
  readonly socket: WebSocket;
  readonly frames: any[] = [];
  readonly closeInfo: Promise<{ code: number; reason: string }>;
  private cursor = 0;
  private waiter: (() => void) | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)));
      const w = this.waiter;
      this.waiter = null;
      if (w) w();
    });
    this.closeInfo = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        resolve({ code, reason: String(reason) });
        const w = this.waiter;
        this.waiter = null;
        if (w) w();
      });
    });
  }

  static async open(h: Harness, urlPath: string): Promise<FrameLog> {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}${urlPath}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(err));
      socket.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected with ${res.statusCode}`)));
    });
    return new FrameLog(socket);
  }

  /** Await the next frame not yet consumed by this log. */
  async next(timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (this.cursor >= this.frames.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for a WebSocket frame');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        const t = setTimeout(resolve, Math.min(remaining, 100));
        t.unref();
      });
    }
    return this.frames[this.cursor++];
  }

  /** Assert nothing new arrives within ms (used for push-filtering proof). */
  async expectSilence(ms: number): Promise<void> {
    const before = this.frames.length;
    await sleep(ms);
    if (this.frames.length !== before) {
      throw new Error(`expected no frames, received ${JSON.stringify(this.frames.slice(before))}`);
    }
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

/** Try to open a WS and return the rejection status instead of throwing. */
export async function wsUpgradeStatus(h: Harness, urlPath: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}${urlPath}`);
    socket.once('open', () => {
      socket.close();
      resolve(101);
    });
    socket.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    socket.once('error', (err) => reject(err));
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}
