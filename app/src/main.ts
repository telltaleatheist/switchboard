import { app, BrowserWindow, Tray, Menu, dialog, ipcMain } from 'electron';
import * as path from 'node:path';

import { IPC_GET_CONFIG } from './ipc-channels';
import { serverEntryPath, uiIndexPath } from './paths';
import { buildAdvertisedUrls } from './network';
import { ServerManager } from './server-manager';
import { createPlaceholderIcon } from './tray-icon';
import type { SwitchboardConfig } from './types';

const SERVER_PORT = 4400;
const SERVER_HOST = '0.0.0.0';
const SHUTDOWN_TIMEOUT_MS = 5000;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverManager: ServerManager | null = null;
let serverInfo: { port: number; operatorToken: string } | null = null;

/** True once before-quit has decided the app really is quitting, so window
 * 'close' handlers let the window close instead of hiding it to tray. */
let isQuitting = false;
/** Guards performGracefulShutdown() against re-entrant before-quit events. */
let shutdownStarted = false;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    icon: createPlaceholderIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Dev override per ARCHITECTURE.md, e.g. http://localhost:4200 for `ng serve`.
  const devUrl = process.env['SWITCHBOARD_UI_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(uiIndexPath());
  }

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[switchboard-app] renderer failed to load:', {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  // Closing the window hides to tray; only the real quit sequence
  // (before-quit, below) actually tears the window down.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): Tray {
  const trayIcon = new Tray(createPlaceholderIcon());
  trayIcon.setToolTip('Switchboard');
  trayIcon.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showMainWindow() },
      { type: 'separator' },
      // Quit funnels through app.quit() -> 'before-quit' so the graceful
      // shutdown sequence runs identically no matter what triggered quit.
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  trayIcon.on('click', () => showMainWindow());
  return trayIcon;
}

/**
 * Called when the server process dies unexpectedly after having reached
 * ready. Per ARCHITECTURE.md: show a visible error state, never restart
 * silently. There is no channel back to the renderer for this beyond the
 * native dialog (the preload surface is intentionally just getConfig()), so
 * a native error dialog is the failure-is-loud mechanism here.
 */
function handleServerCrash(message: string): void {
  console.error('[switchboard-app] switchboard server crashed:', message);
  serverInfo = null;
  dialog.showErrorBox(
    'Switchboard server stopped',
    'The switchboard server process exited unexpectedly and was not restarted.\n\n' +
      message +
      '\n\nRestart Switchboard to reconnect.'
  );
}

async function performGracefulShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (!serverManager) return;
  try {
    await serverManager.shutdown(SHUTDOWN_TIMEOUT_MS);
  } catch (err) {
    // shutdown() is designed not to throw, but never let a cleanup bug
    // block the app from actually quitting.
    console.error('[switchboard-app] error during server shutdown:', err);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_GET_CONFIG, (): SwitchboardConfig => {
    if (!serverInfo) {
      // Fail loudly rather than returning a partial/placeholder config: the
      // renderer should never silently render with no server to talk to.
      throw new Error('Switchboard server is not ready.');
    }
    return {
      baseUrl: `http://127.0.0.1:${serverInfo.port}`,
      operatorToken: serverInfo.operatorToken,
      advertisedUrls: buildAdvertisedUrls(serverInfo.port),
    };
  });
}

async function main(): Promise<void> {
  await app.whenReady();

  registerIpcHandlers();

  const dataDir = path.join(app.getPath('userData'), 'switchboard-data');

  serverManager = new ServerManager({
    serverEntryPath: serverEntryPath(),
    port: SERVER_PORT,
    host: SERVER_HOST,
    dataDir,
    onStderrLine: (line) => console.error('[switchboard-server:stderr]', line),
    onCrash: handleServerCrash,
  });

  let ready: { port: number; operatorToken: string };
  try {
    ready = await serverManager.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[switchboard-app] failed to start switchboard server:', message);
    dialog.showErrorBox('Switchboard failed to start', `The switchboard server did not start.\n\n${message}`);
    app.quit();
    return;
  }

  serverInfo = ready;
  console.log(`[switchboard-app] switchboard server ready on port ${ready.port}`);

  tray = createTray();
  mainWindow = createMainWindow();

  app.on('activate', () => {
    // macOS convention: clicking the dock icon reveals the window again.
    showMainWindow();
  });
}

app.on('window-all-closed', () => {
  // The window hides to tray rather than closing, so this normally only
  // fires during the real quit sequence below — do not quit here, the app
  // is meant to keep running tray-resident.
});

app.on('before-quit', (event) => {
  if (isQuitting) return; // cleanup already ran; let this quit proceed.
  event.preventDefault();
  isQuitting = true;
  void performGracefulShutdown().finally(() => {
    tray?.destroy();
    app.quit();
  });
});

main().catch((err) => {
  console.error('[switchboard-app] fatal error during startup:', err);
  dialog.showErrorBox('Switchboard failed to start', String(err instanceof Error ? err.message : err));
  app.quit();
});
