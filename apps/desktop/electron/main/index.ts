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

// Set the user-facing app name BEFORE app.whenReady so the macOS
// menu bar / Dock and Windows taskbar pick it up. Falls through to
// the packaged productName for the bundled .app/.exe.
app.setName('MoxxyAI Workspaces');
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunnerPool, UNBOUND_ID } from './runner-pool';
import { bindWindow, registerIpcHandlers } from './ipc';
import { DeskStore } from './desks';
import { sweepStaleSockets } from './sweep-sockets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

let pool: RunnerPool | null = null;
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  // The renderer is served either from Vite's dev server or from the
  // packaged dist/. The window icon needs a filesystem path though
  // (Electron doesn't accept http:// urls for `icon`), so we resolve
  // it relative to the built dist/ in prod and the renderer source
  // in dev.
  const iconPath = isDev
    ? path.join(__dirname, '..', '..', '..', 'public', 'logo.png')
    : path.join(__dirname, '..', '..', 'dist', 'logo.png');

  // Hosts where Clerk's OAuth popup is allowed to open. Anything else
  // returns `action: 'deny'` so we don't accidentally let arbitrary
  // window.open() calls spawn full Electron windows.
  const OAUTH_HOST_PATTERNS = [
    /^https:\/\/.*\.clerk\.accounts\.dev$/,
    /^https:\/\/.*\.clerk\.com$/,
    /^https:\/\/accounts\.google\.com$/,
    /^https:\/\/appleid\.apple\.com$/,
    /^https:\/\/github\.com$/,
  ];

  mainWindow = new BrowserWindow({
    title: 'MoxxyAI Workspaces',
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#f1f2f9',
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.mjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  // OAuth popup handling — Clerk's clerk-js calls window.open() to
  // run the provider's OAuth flow. We allow popups whose origin is on
  // the OAUTH_HOST_PATTERNS list (Clerk's own domain + the major
  // providers' login pages), open them as child BrowserWindows that
  // share this window's session (so cookies/localStorage are visible
  // to the renderer when the popup closes), and deny everything else.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const origin = new URL(url).origin;
      if (OAUTH_HOST_PATTERNS.some((re) => re.test(origin))) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 480,
            height: 640,
            minWidth: 380,
            minHeight: 480,
            autoHideMenuBar: true,
            parent: mainWindow ?? undefined,
            modal: false,
            webPreferences: {
              contextIsolation: true,
              sandbox: true,
              // No preload: this is third-party Clerk/OAuth UI; we don't
              // want our IPC surface exposed.
            },
          },
        };
      }
    } catch {
      /* malformed URL → deny */
    }
    return { action: 'deny' };
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
  // Reap any orphan runners from a previous crashed desktop process
  // before we try to spawn new ones. Without this, the first workspace
  // a returning user opens hits EADDRINUSE because a zombie moxxy serve
  // still has 4040 (or the workspace's unix socket) bound.
  const swept = await sweepStaleSockets();
  if (swept.killed.length || swept.removed.length) {
    // eslint-disable-next-line no-console
    console.log(
      `[moxxy] swept ${swept.removed.length} stale socket(s), killed ${swept.killed.length} orphan pid(s)`,
    );
  }
  for (const err of swept.errors) {
    // eslint-disable-next-line no-console
    console.warn('[moxxy] sweep:', err);
  }

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
