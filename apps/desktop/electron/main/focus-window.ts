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
/** Pin the bottom-right corner so resizes feel anchored to the
 *  screen corner instead of sliding the window around. */
export function resizeFocusWindow(width: number, height: number): void {
  if (!focusWindow || focusWindow.isDestroyed()) return;
  const work = screen.getPrimaryDisplay().workArea;
  const margin = 24;
  const [prevW = 0, prevH = 0] = focusWindow.getSize();
  const [prevX = 0, prevY = 0] = focusWindow.getPosition();
  const snapBottomRight =
    Math.abs(prevX + prevW - (work.x + work.width)) < 80 &&
    Math.abs(prevY + prevH - (work.y + work.height)) < 80;
  focusWindow.setBounds(
    {
      x: snapBottomRight
        ? work.x + work.width - width - margin
        : prevX + (prevW - width),
      y: snapBottomRight
        ? work.y + work.height - height - margin
        : prevY + (prevH - height),
      width,
      height,
    },
    true,
  );
}

export async function showFocusWindow(opts: CreateOpts): Promise<void> {
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.show();
    focusWindow.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  // Start collapsed as a small floating dot. The renderer's
  // FocusWidget calls focus.resize as the user expands it.
  const width = 64;
  const height = 64;
  const margin = 24;
  const win = new BrowserWindow({
    title: 'MoxxyAI · Focus',
    width,
    height,
    x: work.x + work.width - width - margin,
    y: work.y + work.height - height - margin,
    minWidth: 56,
    minHeight: 56,
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

/** Bind main-window lifecycle events that should dismiss the focus
 *  widget. The widget itself is only summoned by an explicit hotkey
 *  / tray action — we deliberately do NOT pop it on minimize, hide,
 *  or full-screen, because macOS fires those for transient state
 *  changes (Space transitions, full-screen slides) and the user
 *  surprised by a mini widget every time is worse than the user
 *  having to press one key. */
export function bindMainWindowMinimize(
  mainWindow: BrowserWindow,
  _opts: CreateOpts,
): void {
  // If the user explicitly restores the main window, the widget is
  // redundant — drop it so we don't end up with both surfaces fighting
  // for the same input.
  mainWindow.on('restore', () => {
    closeFocusWindow();
  });
  mainWindow.on('focus', () => {
    closeFocusWindow();
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
