#!/usr/bin/env node
/**
 * Stages the switchboard server for packaging: server/dist plus the server's
 * PRODUCTION dependencies, with every native module built for ELECTRON's Node
 * ABI rather than the system Node's.
 *
 * Why this exists (the native-module trap): the packaged app has no system
 * `node`, so the server is spawned as `electron.exe <entry>` with
 * ELECTRON_RUN_AS_NODE=1 (see app/src/server-manager.ts). Electron 43 embeds a
 * different Node ABI (NODE_MODULE_VERSION 148) than the system Node 20
 * (ABI 115), so the better-sqlite3 binary sitting in server/node_modules —
 * installed for system Node — would fail to load with
 * "was compiled against a different Node.js version".
 *
 * So: build a clean, self-contained runtime tree under staging/server-runtime,
 * installing the server's prod deps with npm_config_runtime=electron and
 * npm_config_target=<electron version>. prebuild-install then looks for an
 * Electron prebuild and, when none is published for this ABI, falls back to
 * `node-gyp rebuild` against Electron's headers. electron-builder copies the
 * whole tree to resources/server (extraResources, OUTSIDE the asar — .node
 * files cannot be loaded from an asar archive), where the server's own
 * `require` resolves resources/server/node_modules.
 *
 * Usage: node scripts/prepare-server-runtime.js [--platform win32|darwin|linux] [--arch x64|arm64]
 * Defaults to the host platform/arch. Native modules can only be built for the
 * host platform, so the mac artifact must be staged and packaged on a Mac.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const STAGING_DIR = path.join(ROOT, 'staging', 'server-runtime');
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers';

function fail(message) {
  console.error(`[prepare-server-runtime] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { platform: process.platform, arch: process.arch };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--platform' || flag === '--arch') {
      const value = argv[i + 1];
      if (!value) fail(`${flag} requires a value`);
      out[flag.slice(2)] = value;
      i += 1;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function electronVersion() {
  let pkgPath;
  try {
    pkgPath = require.resolve('electron/package.json', { paths: [ROOT] });
  } catch {
    fail('electron is not installed at the repo root — run `npm install` first.');
  }
  return readJson(pkgPath).version;
}

function electronBinary() {
  // electron's main export is the absolute path to the binary for this host.
  let binary;
  try {
    binary = require(require.resolve('electron', { paths: [ROOT] }));
  } catch (err) {
    fail(`could not resolve the electron binary: ${err.message}`);
  }
  if (typeof binary !== 'string' || !fs.existsSync(binary)) {
    fail(
      'the electron binary is missing from node_modules (its postinstall download did not run). ' +
        'Reinstall electron at the repo root before packaging.'
    );
  }
  return binary;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with code ${result.status}`);
}

/** Files that are only needed to *build* the native module, not to run it. */
function pruneBuildLeftovers(moduleDir) {
  const disposable = [
    path.join(moduleDir, 'deps'),
    path.join(moduleDir, 'src'),
    path.join(moduleDir, 'build', 'Release', 'obj'),
    path.join(moduleDir, 'build', 'Release', 'obj.target'),
    path.join(moduleDir, 'build', 'deps'),
    path.join(moduleDir, 'build', 'Release', '.deps'),
  ];
  for (const target of disposable) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  // Windows link leftovers (.pdb/.exp/.lib) sitting next to the .node file.
  const releaseDir = path.join(moduleDir, 'build', 'Release');
  if (fs.existsSync(releaseDir)) {
    for (const entry of fs.readdirSync(releaseDir)) {
      if (/\.(pdb|exp|lib|iobj|ipdb|ilk)$/i.test(entry)) {
        fs.rmSync(path.join(releaseDir, entry), { force: true });
      }
    }
  }
}

function main() {
  const { platform, arch } = parseArgs(process.argv.slice(2));
  const version = electronVersion();
  const serverPkg = readJson(path.join(SERVER_DIR, 'package.json'));
  const serverDist = path.join(SERVER_DIR, 'dist');

  if (!fs.existsSync(path.join(serverDist, 'index.js'))) {
    fail('server/dist/index.js is missing — run `npm run build:server` first.');
  }
  if (!serverPkg.dependencies || Object.keys(serverPkg.dependencies).length === 0) {
    fail('server/package.json declares no dependencies — refusing to stage an empty runtime.');
  }

  console.log(
    `[prepare-server-runtime] staging for electron ${version} (${platform}-${arch}) -> ${STAGING_DIR}`
  );

  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  fs.cpSync(serverDist, path.join(STAGING_DIR, 'dist'), { recursive: true });

  // A minimal package.json: production deps only, so `npm install` here can
  // never drag in typescript/@types or the test tree.
  fs.writeFileSync(
    path.join(STAGING_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'switchboard-server-runtime',
        version: serverPkg.version,
        private: true,
        main: 'dist/index.js',
        dependencies: serverPkg.dependencies,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: STAGING_DIR,
    shell: true,
    env: {
      ...process.env,
      // These are what make prebuild-install / node-gyp target Electron's ABI
      // instead of the system Node's.
      npm_config_runtime: 'electron',
      npm_config_target: version,
      npm_config_disturl: ELECTRON_HEADERS_URL,
      npm_config_arch: arch,
      npm_config_target_arch: arch,
      npm_config_target_platform: platform,
      npm_config_build_from_source: 'false',
    },
  });

  pruneBuildLeftovers(path.join(STAGING_DIR, 'node_modules', 'better-sqlite3'));

  if (platform !== process.platform || arch !== process.arch) {
    console.warn(
      `[prepare-server-runtime] target ${platform}-${arch} is not this host — skipping the ABI ` +
        'load check. Verify on the target machine before shipping.'
    );
    return;
  }

  // The whole point of this script: prove the staged native module actually
  // loads under Electron's Node, not just that npm reported success.
  const check = [
    'const Database = require("better-sqlite3");',
    'const db = new Database(":memory:");',
    'db.prepare("select 1 as ok").get();',
    'db.close();',
    'require("ws");',
    'console.log("abi-check ok: node=" + process.versions.node + " modules=" + process.versions.modules + " electron=" + process.versions.electron);',
  ].join('');

  run(electronBinary(), ['-e', check], {
    cwd: STAGING_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  console.log('[prepare-server-runtime] staged runtime is loadable under Electron.');
}

main();
