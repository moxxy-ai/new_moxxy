/**
 * Shared plumbing for the per-domain IPC handler modules.
 *
 * The {@link handle} wrapper is the SINGLE choke point through which
 * every renderer→main command flows: it runtime-validates the payload
 * (via `validateIpcInput`) before any handler touches the filesystem /
 * a child process / the vault. Every domain module registers through
 * it so a new command can't skip the boundary check.
 *
 * The rest of the exports are the small set of lookups the domain
 * handlers share:
 *
 *   - {@link drivers} — the per-workspace {@link SessionDriver} registry
 *     shared between the session handlers (runTurn / abortTurn) and
 *     `bindWindow`, which owns the drivers' lifecycle.
 *   - {@link resolveSupervisor} / {@link mustRemote} / {@link mustSession} —
 *     workspace → supervisor → RemoteSession resolution, with the
 *     "not connected to a runner" guards the session/settings handlers
 *     rely on.
 *   - {@link waitForSessionState} — the post-RPC settle poll that keeps
 *     the renderer's provider/mode pickers from snapping back.
 *   - {@link getInProcessPlugins} — the lazily-built bag of in-process
 *     plugins (vault + Codex transcriber) re-used across IPC calls.
 */

import { ipcMain } from 'electron';

import type {
  IpcCommandName,
  IpcCommands,
} from '@moxxy/desktop-ipc-contract';
import { validateIpcInput } from '@moxxy/desktop-ipc-contract/validation';
import type { SessionLike } from '@moxxy/sdk';

import type { RunnerSupervisor } from '../runner-supervisor';
import type { RunnerPool } from '../runner-pool';
import type { SessionDriver } from '../session-driver';
import { buildInProcessPlugins, type InProcessPlugins } from '../in-process-plugins';

/** Driver lookup shared across the IPC handlers + bindWindow. Keyed by
 *  workspace id so runTurn / abortTurn target the right runner. */
export const drivers = new Map<string, SessionDriver>();

/**
 * Strongly-typed `ipcMain.handle` — channel + arg shapes come from
 * `IpcCommands` so a renamed command surfaces as a type error.
 */
export function handle<K extends IpcCommandName>(
  channel: K,
  fn: (
    ...args: Parameters<IpcCommands[K]>
  ) => Promise<Awaited<ReturnType<IpcCommands[K]>>>,
): void {
  ipcMain.handle(channel, (_evt, ...args) => {
    // Runtime-validate the payload at the boundary before any handler
    // touches the filesystem / a child process / the vault. Schemas
    // exist only for the security-sensitive commands; the rest pass
    // through (validateIpcInput is a no-op without a schema).
    validateIpcInput(channel, args[0]);
    return fn(...(args as Parameters<IpcCommands[K]>));
  });
}

export function resolveSupervisor(
  pool: RunnerPool,
  workspaceId?: string,
): RunnerSupervisor | null {
  const id = workspaceId ?? pool.activeWorkspaceId();
  return id ? pool.get(id) : null;
}

export function mustSession(pool: RunnerPool, workspaceId?: string): SessionLike {
  return mustRemote(pool, workspaceId) as unknown as SessionLike;
}

export function mustRemote(
  pool: RunnerPool,
  workspaceId?: string,
): NonNullable<ReturnType<RunnerSupervisor['remote']>> {
  const sup = resolveSupervisor(pool, workspaceId);
  const session = sup?.remote();
  if (!session) throw new Error('not connected to a runner');
  return session;
}

/**
 * Poll `session.getInfo()` until `predicate` holds or `timeoutMs`
 * elapses. setProvider / setMode on RemoteSession fire-and-forget the
 * RPC; without this wait, the IPC returns before the runner's
 * InfoChanged notification has updated RemoteSession's local cache,
 * and the renderer's follow-up `session.info` fetch reads the
 * pre-change state — making the picker visibly snap back to the old
 * value until the user clicks a second time. Cheap polling here is
 * the right trade-off vs. surgery on the runner client view.
 */
export async function waitForSessionState(
  session: NonNullable<ReturnType<RunnerSupervisor['remote']>>,
  predicate: (info: ReturnType<typeof session.getInfo>) => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate(session.getInfo())) return;
    } catch {
      /* getInfo throws before attach — bail */
      return;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

export function mustDriver(workspaceId: string): SessionDriver {
  const driver = drivers.get(workspaceId);
  if (!driver) {
    throw new Error(`no active session for workspace ${workspaceId}`);
  }
  return driver;
}

/**
 * Lazily-built bag of in-process plugins (Codex transcriber today,
 * extensible to more). Built on first access so the cost of the
 * keychain / vault probe is paid only when the user actually exercises
 * one of these capabilities. Re-used across IPC calls so the
 * underlying VaultStore caches its master key.
 */
let pluginsCache: InProcessPlugins | null = null;
export function getInProcessPlugins(): InProcessPlugins {
  if (!pluginsCache) pluginsCache = buildInProcessPlugins();
  return pluginsCache;
}
