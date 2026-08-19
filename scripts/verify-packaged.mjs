#!/usr/bin/env node
/**
 * Proves that the PACKAGED server actually runs under the PACKAGED Electron's
 * Node — the one thing that silently breaks when a native module was compiled
 * for the wrong ABI. No GUI is launched: the Electron binary is re-executed as
 * plain Node via ELECTRON_RUN_AS_NODE=1, exactly as app/src/server-manager.ts
 * does in packaged mode.
 *
 * It spawns the child itself and owns the handle, so cleanup is by handle —
 * never by image name.
 *
 * Usage:
 *   node scripts/verify-packaged.mjs [--app-dir <dir>] [--exe <path>] [--server <path>]
 * Defaults: release/win-unpacked on Windows; the first existing
 * release/mac-<arch>/Switchboard.app/Contents on macOS. Pass --app-dir
 * (or --exe/--server) to override.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[verify-packaged] FAIL: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--app-dir' || flag === '--exe' || flag === '--server') {
      const value = argv[i + 1];
      if (!value) fail(`${flag} requires a value`);
      out[flag.slice(2).replace('-dir', 'Dir')] = value;
      i += 1;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** Platform-correct default output dir; --app-dir always wins. */
function defaultAppDir() {
  if (process.platform !== 'darwin') return path.join('release', 'win-unpacked');
  // electron-builder names the dir by arch (mac-arm64 / mac); take whichever exists.
  for (const dir of ['mac-arm64', 'mac', 'mac-x64']) {
    const candidate = path.join('release', dir, 'Switchboard.app', 'Contents');
    if (fs.existsSync(path.resolve(ROOT, candidate))) return candidate;
  }
  fail('no packaged .app found under release/ — run npm run package:mac first, or pass --app-dir');
}

const appDir = path.resolve(ROOT, args.appDir ?? defaultAppDir());
const exePath = path.resolve(
  appDir,
  args.exe ?? (process.platform === 'darwin' ? 'MacOS/Switchboard' : 'Switchboard.exe')
);
const serverEntry = path.resolve(
  appDir,
  args.server ??
    (process.platform === 'darwin'
      ? 'Resources/server/dist/index.js'
      : 'resources/server/dist/index.js')
);

for (const [label, file] of [
  ['packaged Electron binary', exePath],
  ['packaged server entry', serverEntry],
]) {
  if (!fs.existsSync(file)) fail(`${label} not found at ${file} — run the packaging script first.`);
}

// The GUI is never launched here, so check the asar payload the same way
// Electron would see it: from inside Electron's own (asar-aware) fs.
const asarProbe = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const root = path.join(process.resourcesPath, "app.asar");',
  'for (const rel of ["app/dist/main.js", "app/dist/preload.js", "ui/dist/ui/browser/index.html"]) {',
  '  const file = path.join(root, rel);',
  '  if (!fs.existsSync(file)) { console.error("missing in asar: " + rel); process.exit(1); }',
  '  console.log("asar ok: " + rel);',
  '}',
].join('');

const probe = spawnSync(exePath, ['-e', asarProbe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  windowsHide: true,
});
if (probe.stdout) process.stdout.write(probe.stdout);
if (probe.stderr) process.stderr.write(probe.stderr);
if (probe.status !== 0) fail('the packaged asar is missing app or ui files (see above)');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-verify-'));

console.log('[verify-packaged] exe    :', exePath);
console.log('[verify-packaged] server :', serverEntry);
console.log('[verify-packaged] dataDir:', dataDir);

const child = spawn(
  exePath,
  [serverEntry, '--port', '0', '--host', '127.0.0.1', '--data-dir', dataDir],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  }
);

console.log('[verify-packaged] spawned pid', child.pid);

let ready = null;
let exited = false;
child.once('exit', (code, signal) => {
  exited = true;
  console.log(`[verify-packaged] child exited code=${code} signal=${signal}`);
  if (!ready) {
    fail('the packaged server exited before printing its ready line');
  }
});

readline.createInterface({ input: child.stderr }).on('line', (line) => {
  console.error('[server:stderr]', line);
});

const readyPromise = new Promise((resolve) => {
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    console.log('[server:stdout]', line);
    if (ready) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed && parsed.ready === true) {
      ready = parsed;
      resolve(parsed);
    }
  });
});

const timeout = new Promise((_resolve, reject) =>
  setTimeout(() => reject(new Error('timed out after 30s waiting for the ready line')), 30000)
);

let exitCode = 0;
try {
  const info = await Promise.race([readyPromise, timeout]);
  if (typeof info.port !== 'number' || typeof info.operatorToken !== 'string') {
    throw new Error(`ready line is malformed: ${JSON.stringify(info)}`);
  }
  console.log(`[verify-packaged] READY on port ${info.port}, operator token present`);

  const res = await fetch(`http://127.0.0.1:${info.port}/v1/version`);
  const body = await res.text();
  console.log(`[verify-packaged] GET /v1/version -> ${res.status} ${body}`);
  if (res.status !== 200) throw new Error(`/v1/version returned ${res.status}`);

  // The skill file ships as extraResources and is resolved relative to
  // server/dist — a layout only a packaged build exercises, so the unit
  // tests cannot catch it going missing. A new operator's very first step
  // depends on this endpoint answering.
  const skill = await fetch(`http://127.0.0.1:${info.port}/v1/skill`);
  const skillBody = await skill.text();
  console.log(`[verify-packaged] GET /v1/skill -> ${skill.status} (${skillBody.length} bytes)`);
  if (skill.status !== 200) throw new Error(`/v1/skill returned ${skill.status}`);
  if (!skillBody.startsWith('---')) throw new Error('/v1/skill did not return the skill markdown');

  const auth = await fetch(`http://127.0.0.1:${info.port}/v1/agents`, {
    headers: { Authorization: `Bearer ${info.operatorToken}` },
  });
  const authBody = await auth.text();
  console.log(`[verify-packaged] GET /v1/agents (operator) -> ${auth.status} ${authBody}`);
  if (auth.status !== 200) throw new Error(`/v1/agents returned ${auth.status}`);

  console.log('[verify-packaged] PASS — packaged server runs under Electron as node.');
} catch (err) {
  console.error(`[verify-packaged] FAIL: ${err.message}`);
  exitCode = 1;
}

// Graceful shutdown over stdin, per the CLI contract; hard-kill this specific
// child by handle if it does not honour it.
if (!exited) {
  const gone = new Promise((resolve) => child.once('exit', () => resolve('exited')));
  try {
    child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
  } catch (err) {
    console.error('[verify-packaged] could not write shutdown to stdin:', err.message);
  }
  const result = await Promise.race([
    gone,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  if (result === 'timeout') {
    console.error('[verify-packaged] child ignored shutdown; killing pid', child.pid);
    child.kill();
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 2000))]);
    exitCode = 1;
  } else {
    console.log('[verify-packaged] child shut down gracefully.');
  }
}

fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(exitCode);
