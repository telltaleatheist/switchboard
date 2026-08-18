import { contextBridge, ipcRenderer } from 'electron';
import type { SwitchboardConfig } from './types';

// Electron sandboxes renderers by default, and a sandboxed preload cannot
// require() relative modules — importing this constant from ipc-channels.ts
// makes the whole preload die silently and the bridge never appears. The
// preload must stay a single self-contained file; this literal MUST match
// IPC_GET_CONFIG in ipc-channels.ts (compile-time-checked in main, not here).
const IPC_GET_CONFIG = 'switchboard:get-config';

/**
 * The entire renderer-facing surface, per ARCHITECTURE.md app/ contract:
 * exactly `window.switchboard.getConfig()`. contextIsolation is on and
 * nodeIntegration is off (see main.ts), so this bridge is the renderer's
 * only path to anything main-process-side.
 */
contextBridge.exposeInMainWorld('switchboard', {
  getConfig: (): Promise<SwitchboardConfig> => ipcRenderer.invoke(IPC_GET_CONFIG),
});
