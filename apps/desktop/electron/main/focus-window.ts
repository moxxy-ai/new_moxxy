/**
 * Focus mode — frameless, transparent, always-on-top mini window
 * that floats over other apps. Same renderer bundle as the main app
 * but with the URL hash `#focus`; main.tsx reads the hash and mounts
 * <FocusWidget/> instead of <App/>.
 *
 * It's not a real Apple Live Activity (those are iOS only) — for an
 * Electron app on macOS this is the canonical pattern: a small
 * vibrant window pinned to a screen corner that hosts a status read-
 * out plus the next-action affordances (input + mic).
 */

import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';

let focusWindow: BrowserWindow | null = null;

interface CreateOpts {
  readonly devUrl?: string;
  readonly preloadPath: string;
  readonly indexHtml: string;
}

export function isFocusOpen(): boolean {
  return !!focusWindow && !focusWindow.isDestroyed();
}

/** Toggle the focus widget. Called from the tray menu / shortcut /
 *  main-window minimize handler. */
export async function toggleFocusWindow(opts: CreateOpts): Promise<void> {
  if (isFocusOpen()) {
    closeFocusWindow();
  } else {
    await showFocusWindow(opts);
  }
}

export function closeFocusWindow(): void {
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.close();
    focusWindow = null;
  }
}

/** Spawn (or focus) the floating widget. Anchored to the bottom-
 *  right of the primary display by default; user-draggable while
 *  open. */
export async function showFocusWindow(opts: CreateOpts): Promise<void> {
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.show();
    focusWindow.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  const width = 380;
  const height = 200;
  const margin = 24;
  const win = new BrowserWindow({
    title: 'MoxxyAI · Focus',
    width,
    height,
    x: work.x + work.width - width - margin,
    y: work.y + work.height - height - margin,
    minWidth: 320,
    minHeight: 160,
    maxWidth: 520,
    maxHeight: 320,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    // macOS-only: hud / popover vibrancy makes the chrome match
    // native floating widgets (Translate / Stickies / etc.).
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating', 1);
  // Visible across desktops + Spaces so the widget follows you when
  // you swipe to a different Space (macOS).
  if (typeof (win as unknown as { setVisibleOnAllWorkspaces?: (v: boolean, opts?: object) => void })
    .setVisibleOnAllWorkspaces === 'function') {
    (win as unknown as { setVisibleOnAllWorkspaces: (v: boolean, opts?: object) => void })
      .setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  focusWindow = win;
  win.on('closed', () => {
    if (focusWindow === win) focusWindow = null;
  });

  // We load the same renderer bundle, just with a hash that flips
  // main.tsx into focus-mode.
  if (opts.devUrl) {
    await win.loadURL(`${opts.devUrl}#focus`);
  } else {
    await win.loadFile(opts.indexHtml, { hash: 'focus' });
  }
}

/** Re-show the widget when the main window is minimized. Called from
 *  index.ts wiring. */
export function bindMainWindowMinimize(
  mainWindow: BrowserWindow,
  opts: CreateOpts,
): void {
  mainWindow.on('minimize', () => {
    void showFocusWindow(opts);
  });
  mainWindow.on('restore', () => {
    closeFocusWindow();
  });
  // On macOS the close button hides instead of quits by default —
  // route to the focus widget too so the user has a way back.
  mainWindow.on('hide', () => {
    if (process.platform === 'darwin') void showFocusWindow(opts);
  });
}

/** Send a payload to the focus widget if it's open. Used by the
 *  bridge to push status updates (active workspace, latest assistant
 *  text). */
export function sendToFocus<K extends string>(channel: K, payload: unknown): void {
  if (!focusWindow || focusWindow.isDestroyed()) return;
  if (focusWindow.webContents.isDestroyed()) return;
  focusWindow.webContents.send(channel, payload);
}

/** Quit helper for the tray menu. */
export function quit(): void {
  app.quit();
}
