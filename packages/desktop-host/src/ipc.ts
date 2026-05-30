/**
 * Wire every IPC handler declared in [`IpcCommands`].
 *
 * Two collaborators:
 *
 *   1. {@link RunnerPool} — one supervisor per workspace; the active
 *      one is the foreground. session.* commands accept an optional
 *      workspaceId arg and default to the active workspace so the
 *      renderer can target background workspaces without switching.
 *
 *   2. {@link DeskStore} — workspace metadata on disk.
 *
 * Events forwarded from each supervisor are tagged with workspaceId
 * (see {@link bindWindow}), so the renderer can dispatch into the
 * right per-workspace chat state and surface "background turn
 * finished in workspace X" notifications later.
 *
 * The handler bodies themselves live in the per-domain modules under
 * `./ipc/*`; this file stays a thin orchestrator that calls each
 * domain registrar (every one funnels through the single validated
 * `handle` choke point in `./ipc/shared`) plus the window-binding
 * lifecycle.
 */

import type { BrowserWindow } from 'electron';

import type { ConnectionPhase, IpcEvents } from '@moxxy/desktop-ipc-contract';
import type { RunnerSupervisor } from './runner-supervisor';
import type { RunnerPool } from './runner-pool';
import { SessionDriver } from './session-driver';
import type { DeskStore } from './desks';
import { drivers } from './ipc/shared';
import { registerAskHandlers } from './ipc/ask';
import { registerConnectionHandlers } from './ipc/connection';
import { registerOnboardingHandlers } from './ipc/onboarding';
import { registerSessionHandlers } from './ipc/session';
import { registerWorkspaceFsHandlers } from './ipc/workspace-fs';
import { registerDesksHandlers } from './ipc/desks';
import { registerWorkflowsHandlers } from './ipc/workflows';
import { registerPrefsHandlers } from './ipc/prefs';
import { registerSettingsHandlers } from './ipc/settings';
import { registerVaultHandlers } from './ipc/vault';
import { registerChatHandlers } from './ipc/chat';

export function registerIpcHandlers(pool: RunnerPool, desks: DeskStore): void {
  registerAskHandlers();
  registerConnectionHandlers(pool);
  registerOnboardingHandlers(pool);
  registerSessionHandlers(pool);
  registerWorkspaceFsHandlers(desks);
  registerDesksHandlers(pool, desks);
  registerWorkflowsHandlers(pool);
  registerPrefsHandlers();
  registerSettingsHandlers(pool);
  registerVaultHandlers();
  registerChatHandlers();
}

/**
 * Bind a window to the runner pool: forward every supervisor's
 * `connection.changed` to the renderer, manage per-workspace
 * SessionDrivers so streamed events get the right workspaceId tag,
 * and tear everything down when the window closes.
 *
 * `claimGlobal` controls whether this window's drivers register
 * themselves in the module-level `drivers` map that IPC RPCs
 * (runTurn, abortTurn, …) look up. Pass true for the *primary*
 * window (the main app) and false for secondary surfaces like the
 * focus widget — secondary surfaces still receive every runner
 * event via their own local SessionDriver subscriptions, but the
 * RPC entry-points keep routing through the primary's driver so
 * turn book-keeping (the turns map on the driver) doesn't get
 * split between processes.
 */
export function bindWindow(
  pool: RunnerPool,
  window: BrowserWindow,
  opts: { readonly claimGlobal?: boolean } = {},
): () => void {
  const claimGlobal = opts.claimGlobal ?? true;
  const send = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  // Maintain one SessionDriver per workspace for the lifetime of its
  // active RemoteSession.
  const localDrivers = new Map<string, SessionDriver>();
  // For SECONDARY bindings (focus widget): we don't own the driver,
  // we just attach our window to whichever driver is already in the
  // global registry. Keep the unsubs so the close handler can drop
  // us from the broadcast set without affecting the primary's driver.
  const attachUnsubs = new Map<string, () => void>();

  const ensureDriverFor = (id: string, sup: RunnerSupervisor): void => {
    const session = sup.remote();
    if (claimGlobal) {
      // Primary: own the driver.
      const existing = localDrivers.get(id);
      // A `connected` pool change can fire more than once for the SAME
      // live session (e.g. a secondary window binding, a redundant
      // supervisor re-emit). Disposing+recreating the driver in that
      // case aborts whatever turn is in flight — fatal for plan-execute,
      // whose human-in-the-loop approval keeps a turn parked for many
      // seconds. Only rebuild when the underlying session actually
      // changed (a genuine reconnect); otherwise leave the running
      // driver — and its in-flight turn — untouched.
      if (existing && session && existing.wraps(session)) return;
      if (existing) existing.dispose();
      if (session) {
        const driver = new SessionDriver(session, window, id);
        localDrivers.set(id, driver);
        drivers.set(id, driver);
      } else {
        localDrivers.delete(id);
        drivers.delete(id);
      }
      return;
    }

    // Secondary: don't create our own driver — that would split the
    // runner event stream into two pumps. Instead, attach our window
    // to the existing driver so we receive its broadcast.
    attachUnsubs.get(id)?.();
    attachUnsubs.delete(id);
    if (session) {
      const existing = drivers.get(id);
      if (existing) attachUnsubs.set(id, existing.attachWindow(window));
      // If the primary's driver hasn't been built yet, the secondary
      // will pick it up on the next pool change (we re-run this fn
      // every time the supervisor flips state).
    }
  };

  const onPoolChange = (id: string): void => {
    const sup = pool.get(id);
    if (!sup) return;
    const phase = sup.snapshot().phase;
    send('connection.changed', { workspaceId: id, phase });
    if (phase.phase === 'connected') ensureDriverFor(id, sup);
    else {
      // Primary tears down its own driver on disconnect; secondary
      // just drops its attachment.
      if (claimGlobal) {
        const existing = localDrivers.get(id);
        if (existing) {
          existing.dispose();
          localDrivers.delete(id);
          drivers.delete(id);
        }
      } else {
        attachUnsubs.get(id)?.();
        attachUnsubs.delete(id);
      }
    }
  };

  pool.on('change', onPoolChange);

  // If the pool is already populated when the window opens, prime
  // each supervisor's connection state into the renderer.
  for (const { id, supervisor } of pool.list()) {
    const phase: ConnectionPhase = supervisor.snapshot().phase;
    send('connection.changed', { workspaceId: id, phase });
    if (phase.phase === 'connected') ensureDriverFor(id, supervisor);
  }

  return () => {
    pool.off('change', onPoolChange);
    for (const driver of localDrivers.values()) driver.dispose();
    localDrivers.clear();
    // Secondary windows drop their attachments; the primary's driver
    // keeps running for the main window.
    for (const fn of attachUnsubs.values()) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    attachUnsubs.clear();
    if (claimGlobal) drivers.clear();
  };
}
