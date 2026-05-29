/**
 * Electron entry point. Owns the lifecycle of:
 *
 *   - the main window (single, for now — multi-window is deferred)
 *   - the [`RunnerSupervisor`] (started before the window opens; the
 *     supervisor's first `connection.changed` event lands at the
 *     renderer the moment the preload bridge is ready)
 *   - the IPC wiring
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunnerPool, UNBOUND_ID } from './runner-pool';
import { bindWindow, registerIpcHandlers } from './ipc';
import { DeskStore } from './desks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

let pool: RunnerPool | null = null;
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'moxxy',
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#08080c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.mjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  if (isDev) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  if (pool) {
    const unbind = bindWindow(pool, mainWindow);
    mainWindow.on('closed', () => {
      unbind();
      mainWindow = null;
    });
  }
}

app.whenReady().then(async () => {
  pool = new RunnerPool();
  const desks = new DeskStore();
  // Prime: spawn a runner for the active workspace if one is bound,
  // otherwise an unbound runner so the user lands in a working chat
  // surface from the first paint.
  const initialActive = await desks.getActive();
  if (initialActive) {
    await pool.getOrCreate(initialActive.id, initialActive.cwd);
    pool.setActive(initialActive.id);
  } else {
    await pool.getOrCreate(UNBOUND_ID, null);
    pool.setActive(UNBOUND_ID);
  }
  registerIpcHandlers(pool, desks);

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let isQuitting = false;
app.on('before-quit', (event) => {
  // Electron does NOT await the before-quit handler; if we just
  // returned a Promise, the process would exit before stop() landed
  // and the child runner would survive as a zombie. Trap the first
  // quit, run cleanup, then fire app.exit() explicitly.
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  void shutdown().finally(() => app.exit(0));
});

async function shutdown(): Promise<void> {
  if (!pool) return;
  await Promise.race([
    pool.stopAll().catch(() => undefined),
    // Belt-and-braces timeout: don't hang the app on a stuck child.
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}
