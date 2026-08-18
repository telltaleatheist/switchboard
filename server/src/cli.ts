/**
 * Argument parsing for the CLI contract:
 *   node dist/index.js --port 4400 --host 0.0.0.0 --data-dir <path>
 * All three are required — a missing flag is an error, never a default.
 */

import * as path from 'node:path';
import type { Config } from './context';

export const USAGE =
  'usage: node dist/index.js --port <n> --host <addr> --data-dir <path> [--idle-days <n>] [--sweep-interval-ms <n>]';

const KNOWN = ['--port', '--host', '--data-dir', '--idle-days', '--sweep-interval-ms'] as const;

export class CliError extends Error {}

export function parseArgs(argv: readonly string[]): Config {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!flag.startsWith('--')) throw new CliError(`unexpected argument '${flag}'`);
    if (!(KNOWN as readonly string[]).includes(flag)) throw new CliError(`unknown flag '${flag}'`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`flag '${flag}' requires a value`);
    if (values.has(flag)) throw new CliError(`flag '${flag}' was given more than once`);
    values.set(flag, value);
    i++;
  }

  const portRaw = required(values, '--port');
  if (!/^\d+$/.test(portRaw)) throw new CliError(`--port must be an integer (got '${portRaw}')`);
  const port = Number(portRaw);
  if (port > 65535) throw new CliError(`--port must be between 0 and 65535 (got ${port})`);

  const host = required(values, '--host');
  const dataDir = path.resolve(required(values, '--data-dir'));

  const idleRaw = values.get('--idle-days') ?? '14';
  if (!/^\d+$/.test(idleRaw)) throw new CliError(`--idle-days must be a non-negative integer (got '${idleRaw}')`);

  const sweepRaw = values.get('--sweep-interval-ms') ?? String(60 * 60 * 1000);
  if (!/^\d+$/.test(sweepRaw) || Number(sweepRaw) < 1000) {
    throw new CliError(`--sweep-interval-ms must be an integer >= 1000 (got '${sweepRaw}')`);
  }

  return {
    port,
    host,
    dataDir,
    idleDays: Number(idleRaw),
    sweepIntervalMs: Number(sweepRaw),
  };
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) throw new CliError(`missing required flag '${flag}'`);
  return value;
}
