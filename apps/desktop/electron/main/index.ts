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

import {
  RunnerPool,
  UNBOUND_ID,
  bindWindow,
  registerIpcHandlers,
  DeskStore,
  sweepStaleSockets,
  bindMainWindowMinimize,
  closeFocusWindow,
  resizeFocusWindow,
  showFocusWindow,
  toggleFocusWindow,
  installContentSecurityPolicy,
  lockDownNavigation,
  isSafeExternalUrl,
  preferredCliEntry,
} from '@moxxy/desktop-host';

// In a packaged build there is no global `moxxy` (and a GUI launch has no
// shell PATH / system `node`). Point the CLI resolver at a self-contained,
// pinned CLI run via Electron's own Node (ELECTRON_RUN_AS_NODE), preferring a
// version the user updated from within the app over the one bundled with this
// release. Respects an explicit MOXXY_CLI_ENTRY override (dev / power users).
// The in-app "Update CLI" action re-points the same env var via the shared
// preferredCliEntry() helper after installing into writable userData.
if (app.isPackaged && !process.env.MOXXY_CLI_ENTRY) {
  const entry = preferredCliEntry(app.getPath('userData'), process.resourcesPath);
  if (entry) process.env.MOXXY_CLI_ENTRY = entry;
}
import { ipcMain, Tray, Menu, nativeImage, globalShortcut, session, shell } from 'electron';

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
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      // The preload bridge only touches ipcRenderer + contextBridge, so
      // the OS process sandbox is safe to enable — it shrinks the blast
      // radius of a renderer compromise to "can't reach Node directly."
      sandbox: true,
    },
  });

  // Refuse top-frame navigation away from our own origin. The OAuth
  // popups open via the `setWindowOpenHandler` below (kept intact), not
  // by navigating this frame, so sign-in is unaffected.
  lockDownNavigation(mainWindow, { keepWindowOpenHandler: true });

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
      return { action: 'deny' };
    }
    // Any other http/https link (e.g. a markdown link in the chat, opened
    // via target="_blank") goes to the user's default browser rather than an
    // in-app window. Non-http(s) schemes are refused outright.
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
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

  // Focus mode wiring — when the user minimizes / hides the main
  // window, surface the floating widget instead.
  const focusOpts = {
    devUrl: isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    preloadPath: path.join(__dirname, '..', 'preload', 'index.cjs'),
    indexHtml: path.join(__dirname, '..', '..', 'dist', 'index.html'),
    focusHtml: path.join(__dirname, '..', '..', 'dist', 'focus.html'),
    /** Bind the focus widget to the same runner pool as the main
     *  window so it sees connection state + every runner event, but
     *  pass claimGlobal: false so the IPC RPC routing (runTurn /
     *  abortTurn / …) still goes through the main window's driver. */
    attach: (win: BrowserWindow) => {
      if (!pool) return () => undefined;
      return bindWindow(pool, win, { claimGlobal: false });
    },
  };
  bindMainWindowMinimize(mainWindow, focusOpts);

  // Focus mode floats a tiny always-on-top widget over your desktop.
  // On macOS, native fullscreen puts the main window in its own Space;
  // spawning the floating widget there never surfaces the bar and instead
  // wedges the app — the main window's controls vanish and it won't close
  // (needs a force-quit). So focus mode is unavailable while the main
  // window is fullscreen: the menu items grey out and every handler
  // (including the global shortcut, which has no disabled state) no-ops.
  const focusModeAvailable = (): boolean =>
    !(
      process.platform === 'darwin' &&
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isFullScreen()
    );

  const openMainAndCloseFocus = (): void => {
    closeFocusWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    // macOS: ensure the app is foregrounded even if the window
    // was hidden behind another Space.
    if (process.platform === 'darwin') app.focus({ steal: true });
  };

  const requestFocusToggle = (): void => {
    if (!focusModeAvailable()) return;
    void toggleFocusWindow(focusOpts);
  };

  // (Re)build the tray context menu + application menu, greying out the
  // focus-mode entries whenever focus mode isn't currently available.
  const applyMenus = (): void => {
    const focusEnabled = focusModeAvailable();
    if (trayInstance) {
      trayInstance.setContextMenu(
        Menu.buildFromTemplate([
          // Heading row — disabled item that just labels the menu so
          // the user knows which app this tray belongs to. macOS dims
          // disabled items so it reads as a header.
          { label: 'MoxxyAI Workspaces', enabled: false },
          { type: 'separator' },
          { label: 'Open main window', click: openMainAndCloseFocus },
          { label: 'Toggle focus mode', enabled: focusEnabled, click: requestFocusToggle },
          { type: 'separator' },
          { role: 'quit' },
        ]),
      );
    }
    installApplicationMenu(requestFocusToggle, openMainAndCloseFocus, focusEnabled);
  };

  // Entering fullscreen drops any open widget and disables the toggles;
  // leaving re-enables them.
  mainWindow.on('enter-full-screen', () => {
    closeFocusWindow();
    applyMenus();
  });
  mainWindow.on('leave-full-screen', applyMenus);

  // Tray menu — toggle the widget, restore the main window, quit.
  if (!trayInstance) {
    try {
      // Try several candidate paths because the prod / dev build
      // layouts differ — log which one wins (or report all-empty)
      // so future icon regressions are noisy instead of silent.
      const trayIconCandidates = [
        path.join(__dirname, '..', '..', '..', 'public', 'logo.png'),
        path.join(__dirname, '..', '..', 'dist', 'logo.png'),
        path.join(process.resourcesPath ?? '', 'public', 'logo.png'),
        path.join(process.resourcesPath ?? '', 'logo.png'),
      ];
      let raw = nativeImage.createEmpty();
      let resolvedPath = '';
      for (const p of trayIconCandidates) {
        const candidate = nativeImage.createFromPath(p);
        if (!candidate.isEmpty()) {
          raw = candidate;
          resolvedPath = p;
          break;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        raw.isEmpty()
          ? `[moxxy] tray: NO icon found, fell back to text label. Tried: ${trayIconCandidates.join(', ')}`
          : `[moxxy] tray: icon loaded from ${resolvedPath}`,
      );
      const icon = raw.isEmpty()
        ? nativeImage.createEmpty()
        : raw.resize({ width: 22, height: 22, quality: 'best' });
      // Do NOT setTemplateImage on a colored avatar — the alpha is
      // a near-solid rectangle, which AppKit tints to a featureless
      // blob (or, on some versions, drops to invisible). Render the
      // image as-is; a 18×18 coloured avatar is recognisable on the
      // menu bar.
      trayInstance = new Tray(icon);
      // Fallback title — if the icon couldn't be loaded, at least
      // something is visible in the menu bar (template-image
      // failures + missing PNGs both hit this path).
      if (raw.isEmpty()) trayInstance.setTitle('moxxy');
      trayInstance.setToolTip('MoxxyAI Workspaces');
      // The context menu is built by applyMenus() below (and rebuilt on
      // fullscreen changes) so the focus-mode item can grey out when the
      // main window is fullscreen.
      //
      // We intentionally do NOT bind a left-click → toggle handler
      // here. A bare tray click should just open the menu (the OS
      // default). Focus mode is summoned explicitly via the menu's
      // "Toggle focus mode" item or the keyboard shortcut, so the
      // user is never surprised by it popping up.
    } catch (err) {
      // Surface the failure — silent catch was hiding "icon missing"
      // and "Tray() blew up" alike, leaving the user with no menubar
      // affordance.
      // eslint-disable-next-line no-console
      console.error('[moxxy] tray init failed:', err);
    }
  }

  // Install the tray + application menus now. Focus mode is enabled
  // unless the window already launched into fullscreen.
  applyMenus();

  ipcMain.removeHandler('focus.close');
  ipcMain.handle('focus.close', () => {
    closeFocusWindow();
  });
  ipcMain.removeHandler('focus.restoreMain');
  ipcMain.handle('focus.restoreMain', () => {
    closeFocusWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
  ipcMain.removeHandler('focus.resize');
  ipcMain.handle('focus.resize', (_evt, { width, height }: { width: number; height: number }) => {
    resizeFocusWindow(width, height);
  });

  // System-wide shortcut so the user can summon the widget even when
  // moxxy isn't the focused app. Cmd+Shift+M on mac / Ctrl+Shift+M
  // elsewhere — the same chord the menu shows.
  try {
    globalShortcut.unregister('CommandOrControl+Shift+M');
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      if (!focusModeAvailable()) return;
      void toggleFocusWindow(focusOpts).then(() => {
        if (!mainWindow?.isVisible()) void showFocusWindow(focusOpts);
      });
    });
  } catch {
    /* shortcut may already be claimed — non-fatal */
  }
}

function installApplicationMenu(
  toggleFocus: () => void,
  openMain: () => void,
  focusEnabled: boolean,
): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: 'MoxxyAI Workspaces',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open main window', click: openMain },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Focus Mode',
          accelerator: 'CommandOrControl+Shift+M',
          enabled: focusEnabled,
          click: toggleFocus,
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
          ]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let trayInstance: Tray | null = null;

app.whenReady().then(async () => {
  // Apply the Content-Security-Policy to our own document responses
  // before any window loads. Skipped in dev (Vite HMR needs a loose
  // policy); third-party + OAuth responses are left untouched.
  installContentSecurityPolicy(session.defaultSession, { isDev });

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

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* nothing to clean up */
  }
});

async function shutdown(): Promise<void> {
  if (!pool) return;
  await Promise.race([
    pool.stopAll().catch(() => undefined),
    // Belt-and-braces timeout: don't hang the app on a stuck child.
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}
