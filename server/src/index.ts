#!/usr/bin/env node
/**
 * Switchboard server entry point.
 *
 * Prints exactly one JSON line to stdout when ready:
 *   {"ready":true,"port":4400,"operatorToken":"sw_o_<hex>"}
 * Then listens on stdin for {"cmd":"shutdown"} (and on SIGINT/SIGTERM) to run
 * the graceful shutdown sequence and exit 0.
 */

import * as readline from 'node:readline';
import { CliError, USAGE, parseArgs } from './cli';
import { startSwitchboard, type Switchboard } from './server';

async function main(): Promise<void> {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`switchboard: ${err.message}\n${USAGE}\n`);
      process.exit(1);
    }
    throw err;
  }

  let switchboard: Switchboard;
  try {
    switchboard = await startSwitchboard(config);
  } catch (err) {
    process.stderr.write(`switchboard: failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `${JSON.stringify({ ready: true, port: switchboard.port, operatorToken: switchboard.operatorToken })}\n`,
  );

  let exiting = false;
  const stop = (why: string): void => {
    if (exiting) return;
    exiting = true;
    process.stderr.write(`switchboard: shutting down (${why})\n`);
    switchboard
      .shutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`switchboard: shutdown failed: ${(err as Error).message}\n`);
        process.exit(1);
      });
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      process.stderr.write(`switchboard: ignoring unparseable stdin line: ${text}\n`);
      return;
    }
    const cmd = (parsed as { cmd?: unknown } | null)?.cmd;
    if (cmd === 'shutdown') {
      stop('stdin command');
      return;
    }
    process.stderr.write(`switchboard: unknown stdin command: ${text}\n`);
  });
  // stdin EOF means the parent process died (or deliberately closed the
  // pipe): shut down rather than survive as an orphan squatting on the port.
  // The server's lifetime is its parent's lifetime by design — anyone
  // daemonizing it standalone must keep stdin open.
  rl.on('close', () => stop('stdin closed (parent gone)'));

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`switchboard: uncaught exception: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`switchboard: unhandled rejection: ${String(reason)}\n`);
    process.exit(1);
  });
}

void main();
