import { contextBridge, ipcRenderer } from 'electron';
import { IPC_GET_CONFIG } from './ipc-channels';
import type { SwitchboardConfig } from './types';

/**
 * The entire renderer-facing surface, per ARCHITECTURE.md app/ contract:
 * exactly `window.switchboard.getConfig()`. contextIsolation is on and
 * nodeIntegration is off (see main.ts), so this bridge is the renderer's
 * only path to anything main-process-side.
 */
contextBridge.exposeInMainWorld('switchboard', {
  getConfig: (): Promise<SwitchboardConfig> => ipcRenderer.invoke(IPC_GET_CONFIG),
});
