import * as path from 'node:path';

/**
 * Absolute path to the switchboard monorepo root (the parent of app/,
 * server/, and ui/).
 *
 * Resolved relative to *this compiled file's* location
 * (app/dist/paths.js -> app/dist -> app -> repo root), not via Electron's
 * `app.getAppPath()`. That keeps path resolution correct regardless of
 * Electron bootstrap timing and gives packaged mode one obvious place to
 * diverge later (see the TODO in server-manager.ts).
 */
export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/** Dev-mode contract: `node <this> --port ... --host ... --data-dir ...`. */
export function serverEntryPath(): string {
  return path.join(repoRoot(), 'server', 'dist', 'index.js');
}

/** The built Angular operator console's entry HTML file. */
export function uiIndexPath(): string {
  return path.join(repoRoot(), 'ui', 'dist', 'ui', 'browser', 'index.html');
}
