import * as path from 'node:path';
import { app } from 'electron';

/**
 * Absolute path to the tree that holds `app/`, `server/` and `ui/`.
 *
 * Resolved relative to *this compiled file's* location
 * (app/dist/paths.js -> app/dist -> app -> root), not via Electron's
 * `app.getAppPath()`, so path resolution is correct regardless of Electron
 * bootstrap timing.
 *
 * In a packaged build this deliberately still works: electron-builder ships
 * `app/dist/**` and `ui/dist/ui/browser/**` inside the asar with the same
 * relative layout as the repo, so this returns the asar root
 * (`…/resources/app.asar`). Only the *server* diverges — its code and
 * node_modules must live outside the asar (native `.node` files cannot be
 * loaded from an asar archive), so `serverEntryPath()` branches below.
 */
export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * The server entry, launched per the CLI contract:
 * `<node-ish> <this> --port ... --host ... --data-dir ...`.
 *
 * - Dev: `<repo>/server/dist/index.js`.
 * - Packaged: `<resources>/server/dist/index.js`, staged by
 *   scripts/prepare-server-runtime.js and copied there by electron-builder's
 *   `extraResources` (see electron-builder.yml). Its sibling `node_modules/`
 *   is what the server's own `require` resolves against.
 */
export function serverEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'dist', 'index.js');
  }
  return path.join(repoRoot(), 'server', 'dist', 'index.js');
}

/**
 * The built Angular operator console's entry HTML file. Identical relative
 * path in both modes (dev: on disk; packaged: inside the asar).
 */
export function uiIndexPath(): string {
  return path.join(repoRoot(), 'ui', 'dist', 'ui', 'browser', 'index.html');
}

/**
 * The app icon PNG for runtime use (window + tray). The packaged exe and
 * installer get theirs at build time from buildResources/icon.png; this is
 * the same file, shipped once more via extraResources so the running app
 * can load it too (buildResources itself is never packaged).
 */
export function iconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(repoRoot(), 'build-resources', 'icon.png');
}
