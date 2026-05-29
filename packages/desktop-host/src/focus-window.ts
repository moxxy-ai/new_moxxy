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
import { lockDownNavigation } from './security';

let focusWindow: BrowserWindow | null = null;

interface CreateOpts {
  readonly devUrl?: string;
  readonly preloadPath: string;
  readonly indexHtml: string;
  /** Path to the focus widget's dedicated HTML in the prod bundle.
   *  In dev it's served as ${devUrl}/focus.html instead. */
  readonly focusHtml: string;
  /** Called the moment the focus window is created so the caller
   *  can wire IPC event forwarding (runner.event, turn.complete,
   *  connection.changed) into the secondary surface. Returns an
   *  unbind fn that runs when the window closes. */
  readonly attach?: (win: BrowserWindow) => () => void;
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
/** Resize the widget — anchor to whichever screen edge is closer.
 *
 *  Rationale: a small floating icon naturally lives against one
 *  edge of the work area, not in the middle. Compute which side
 *  (left or right) the widget's centre currently sits closer to,
 *  then pin THAT edge so collapsing retreats outward and expanding
 *  grows inward. Same logic both directions, symmetric.
 *
 *  - Widget centre on left half  → pin LEFT edge.
 *  - Widget centre on right half → pin RIGHT edge.
 *
 *  Y axis: just keep the previous centre Y so the widget doesn't
 *  jump vertically when its height changes.
 */
export function resizeFocusWindow(width: number, height: number): void {
  if (!focusWindow || focusWindow.isDestroyed()) return;
  const work = screen.getPrimaryDisplay().workArea;
  const [prevW = 0, prevH = 0] = focusWindow.getSize();
  const [prevX = 0, prevY = 0] = focusWindow.getPosition();

  const widgetCenterX = prevX + prevW / 2;
  const workCenterX = work.x + work.width / 2;
  const pinRight = widgetCenterX >= workCenterX;

  let nextX: number;
  if (pinRight) {
    // Right edge of the new bounds equals right edge of the old.
    nextX = prevX + prevW - width;
  } else {
    // Left edge stays put — new width grows / shrinks to the right.
    nextX = prevX;
  }

  // Centre Y is preserved so the widget doesn't bounce vertically.
  let nextY = prevY + (prevH - height) / 2;

  // Clamp so we never end up off-screen.
  nextX = Math.max(work.x + 4, Math.min(nextX, work.x + work.width - width - 4));
  nextY = Math.max(work.y + 4, Math.min(nextY, work.y + work.height - height - 4));

  // animate: false → snap, no overshoot.
  focusWindow.setBounds(
    { x: Math.round(nextX), y: Math.round(nextY), width, height },
    false,
  );
}

export async function showFocusWindow(opts: CreateOpts): Promise<void> {
  if (focusWindow && !focusWindow.isDestroyed()) {
    focusWindow.show();
    focusWindow.focus();
    return;
  }

  const work = screen.getPrimaryDisplay().workArea;
  // Start small — a 44×44 floating tile holding the logo. The
  // renderer's FocusWidget calls focus.resize when the user clicks
  // to expand to the menu (200×52) or the full panel (340×…).
  const width = 44;
  const height = 44;
  const margin = 24;
  const win = new BrowserWindow({
    title: 'MoxxyAI · Focus',
    width,
    height,
    x: work.x + work.width - width - margin,
    y: work.y + work.height - height - margin,
    minWidth: 40,
    minHeight: 40,
    maxWidth: 520,
    maxHeight: 320,
    frame: false,
    transparent: true,
    // User asked for fixed dimensions per stage — no edge-resize
    // grabs. setBounds from focus.resize IPC still works.
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    // No OS shadow — the user asked for a flat square look.
    hasShadow: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // The focus widget never opens child windows and never navigates away
  // from its own document — lock both down (deny window.open too).
  lockDownNavigation(win, { keepWindowOpenHandler: false });

  win.setAlwaysOnTop(true, 'floating', 1);
  // Visible across desktops + Spaces so the widget follows you when
  // you swipe to a different Space (macOS).
  if (typeof (win as unknown as { setVisibleOnAllWorkspaces?: (v: boolean, opts?: object) => void })
    .setVisibleOnAllWorkspaces === 'function') {
    (win as unknown as { setVisibleOnAllWorkspaces: (v: boolean, opts?: object) => void })
      .setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  focusWindow = win;
  const unbindAttach = opts.attach?.(win);
  win.on('closed', () => {
    unbindAttach?.();
    if (focusWindow === win) focusWindow = null;
  });

  // Load the *dedicated* focus.html entry. It has its own bundle, its
  // own React tree, and its own preload bridge — no shared
  // module side-effects with the main app.
  if (opts.devUrl) {
    await win.loadURL(`${opts.devUrl}/focus.html`);
  } else {
    await win.loadFile(opts.focusHtml);
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
