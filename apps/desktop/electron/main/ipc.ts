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
 */

import { ipcMain, type BrowserWindow } from 'electron';

import type {
  ConnectionPhase,
  IpcCommandName,
  IpcCommands,
  IpcEvents,
} from '../shared/ipc';
import type { SessionLike } from '@moxxy/sdk';
import { RunnerSupervisor } from './runner-supervisor';
import { RunnerPool, UNBOUND_ID } from './runner-pool';
import { probeOnboarding, saveProviderKey } from './onboarding';
import { installMoxxyCli, probeNode } from './installer';
import { SessionDriver } from './session-driver';
import { DeskStore } from './desks';
import { dialog, shell, BrowserWindow as BrowserWindowApi } from 'electron';

export function registerIpcHandlers(pool: RunnerPool, desks: DeskStore): void {
  // ---- Connection ----------------------------------------------------------

  handle('connection.snapshot', async (args) => {
    const id = args?.workspaceId ?? pool.activeWorkspaceId() ?? UNBOUND_ID;
    const sup = pool.get(id);
    if (!sup) throw new Error(`no supervisor for ${id}`);
    return { workspaceId: id, ...sup.snapshot() };
  });
  handle('connection.snapshotAll', async () =>
    pool.list().map((e) => ({ workspaceId: e.id, ...e.supervisor.snapshot() })),
  );
  handle('connection.activeWorkspace', async () => pool.activeWorkspaceId());
  handle('connection.retry', async (args) => {
    const id = args?.workspaceId ?? pool.activeWorkspaceId();
    if (!id) return;
    pool.get(id)?.forceRetry();
  });

  // ---- Onboarding ----------------------------------------------------------

  handle('onboarding.status', () => probeOnboarding());
  handle('onboarding.probeNode', () => probeNode());
  handle('onboarding.installMoxxyCli', async () => {
    const target = BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    if (!target) throw new Error('no window to stream install progress to');
    const code = await installMoxxyCli(target);
    if (code === 0) pool.active()?.forceRetry();
    return code;
  });
  handle('onboarding.openExternal', async ({ url }) => {
    await shell.openExternal(url);
  });
  handle('onboarding.saveProviderKey', async ({ provider, secret }) => {
    await saveProviderKey(provider, secret);
    const session = pool.active()?.remote();
    if (session) session.providers.setActive(provider);
  });
  handle('onboarding.providerAuthKind', async ({ provider }) => {
    // The only built-in OAuth provider today is openai-codex; admin-
    // registered providers in providers.json are all api-key. Keep
    // this list as the source of truth until the runner exposes
    // provider auth metadata over RPC.
    const OAUTH_PROVIDERS = new Set(['openai-codex']);
    return OAUTH_PROVIDERS.has(provider) ? 'oauth' : 'api-key';
  });
  handle('onboarding.runProviderLogin', async ({ provider }) => {
    const { runProviderLogin } = await import('./installer');
    const target = BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    if (!target) throw new Error('no window to stream login progress to');
    const code = await runProviderLogin(provider, target);
    if (code === 0) pool.active()?.forceRetry();
    return code;
  });

  // ---- Session (per-workspace) --------------------------------------------

  handle('session.info', async (args) => {
    const sup = resolveSupervisor(pool, args?.workspaceId);
    const session = sup?.remote();
    return session ? session.getInfo() : null;
  });
  handle('session.runTurn', async ({ workspaceId, prompt, model }) => {
    const id = workspaceId ?? pool.activeWorkspaceId();
    if (!id) throw new Error('no active workspace');
    const driver = mustDriver(id);
    return driver.runTurn(prompt, model);
  });
  handle('session.abortTurn', async ({ workspaceId, turnId }) => {
    const id = workspaceId ?? pool.activeWorkspaceId();
    if (!id) return;
    drivers.get(id)?.abortTurn(turnId);
  });
  handle('session.setProvider', async ({ workspaceId, provider }) => {
    const session = mustRemote(pool, workspaceId);
    session.providers.setActive(provider);
    await waitForSessionState(session, (info) => info.activeProvider === provider);
  });
  handle('session.setMode', async ({ workspaceId, mode }) => {
    const session = mustRemote(pool, workspaceId);
    session.modes.setActive(mode);
    await waitForSessionState(session, (info) => info.activeMode === mode);
  });
  handle('session.runCommand', async ({ workspaceId, name, args }) => {
    const session = mustRemote(pool, workspaceId);
    const def = session.commands.get(name);
    if (!def) return { kind: 'error', message: `unknown command: /${name}` } as const;
    // The runner doesn't care about the channel name beyond logging,
    // but some command handlers gate behaviour on it. "desktop"
    // mirrors the TUI's "tui" convention and keeps things grep-able.
    const result = await def.handler({
      channel: 'desktop',
      sessionId: session.getInfo().sessionId,
      args,
      session: session as unknown as Parameters<typeof def.handler>[0]['session'],
    });
    return result;
  });
  handle('session.hasTranscriber', async () => {
    const sup = pool.active();
    const session = sup?.remote();
    if (!session) return false;
    return session.transcribers.getActiveName() !== null;
  });
  handle('session.transcribe', async ({ audioBase64, mimeType }) => {
    const session = mustRemote(pool);
    const transcriber = session.transcribers.tryGetActive();
    if (!transcriber) throw new Error('no active transcriber on the runner');
    const audio = Buffer.from(audioBase64, 'base64');
    const result = await transcriber.transcribe(
      audio,
      mimeType ? { mimeType } : undefined,
    );
    return result.text;
  });
  handle('workspace.listDir', async ({ workspaceId, path: relPath }) => {
    const { listDir } = await import('./workspace-fs');
    // Look up the cwd by the workspace id so background workspaces
    // can be browsed too; fall back to the active desk.
    const all = await desks.list();
    const desk = all.find((d) => d.id === workspaceId) ?? (await desks.getActive());
    if (!desk) {
      return { cwd: process.cwd(), path: '.', entries: [] };
    }
    return listDir(desk.cwd, relPath);
  });
  handle('session.pickAttachment', async () => {
    const window =
      BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window ?? null!, {
      title: 'Attach a file to the next prompt',
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  // ---- Desks --------------------------------------------------------------

  handle('desks.list', async () => {
    const list = await desks.list();
    const active = await desks.getActive();
    return { desks: list, activeId: active?.id ?? null };
  });
  handle('desks.create', async ({ name, cwd }) => desks.create({ name, cwd }));
  handle('desks.remove', async ({ id }) => {
    await desks.remove(id);
    await pool.remove(id);
    const active = await desks.getActive();
    if (active) await pool.getOrCreate(active.id, active.cwd);
  });
  handle('desks.setActive', async ({ id }) => {
    await desks.setActive(id);
    const active = await desks.getActive();
    if (active) {
      await pool.getOrCreate(active.id, active.cwd);
      pool.setActive(active.id);
    }
  });
  handle('desks.rename', async ({ id, name }) => desks.rename(id, name));
  handle('desks.pickFolder', async () => {
    const window =
      BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window ?? null!, {
      title: 'Bind a desk to a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  // ---- Workflows -----------------------------------------------------------

  handle('workflows.list', async () => {
    const session = mustSession(pool);
    const view = session.workflows;
    if (!view) return [];
    return await view.list();
  });
  handle('workflows.setEnabled', async ({ name, enabled }) => {
    const session = mustSession(pool);
    if (session.workflows) await session.workflows.setEnabled(name, enabled);
  });
  handle('workflows.run', async ({ name }) => {
    const session = mustSession(pool);
    if (!session.workflows) throw new Error('workflows plugin not loaded');
    return await session.workflows.run(name);
  });

  // ---- Settings -----------------------------------------------------------

  // Desktop preferences -----------------------------------------------------
  handle('prefs.read', async () => {
    const { readPrefs } = await import('./prefs');
    return readPrefs();
  });
  handle('prefs.update', async (patch) => {
    const { updatePrefs } = await import('./prefs');
    return updatePrefs(patch);
  });

  handle('settings.fetchProviderModels', async ({ provider }) => {
    const { fetchProviderModels } = await import('./provider-discovery');
    return await fetchProviderModels(provider);
  });
  handle('settings.adminProviders', async () => {
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const path = await import('node:path');
      const body = await readFile(
        path.join(homedir(), '.moxxy', 'providers.json'),
        'utf8',
      );
      const json = JSON.parse(body) as { providers?: ReadonlyArray<{ name?: string }> };
      return (json.providers ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === 'string');
    } catch {
      return [];
    }
  });
  handle('settings.providerCatalog', async () => {
    // Built-ins are always pickable. Admin-registered ones come from
    // providers.json so the onboarding dropdown reflects whatever the
    // user already added via `provider_add` (zai, openrouter, …).
    const builtins = ['anthropic', 'openai', 'openai-codex'];
    let admin: string[] = [];
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const path = await import('node:path');
      const body = await readFile(
        path.join(homedir(), '.moxxy', 'providers.json'),
        'utf8',
      );
      const json = JSON.parse(body) as {
        providers?: ReadonlyArray<{ name?: string }>;
      };
      admin = (json.providers ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === 'string');
    } catch {
      /* missing or malformed providers.json → builtins only */
    }
    const seen = new Set<string>();
    return [...builtins, ...admin].filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  });
  handle('settings.providers', async (args) => {
    const sup = resolveSupervisor(pool, args?.workspaceId);
    const session = sup?.remote();
    if (!session) return [];
    const info = session.getInfo();
    const readySet = new Set(info.readyProviders ?? []);
    return info.providers.map((p) => ({
      name: p.name,
      ready: readySet.has(p.name),
    }));
  });
  handle('settings.mcpServers', async (args) => {
    const session = mustSession(pool, args?.workspaceId);
    if (!session.mcpAdmin) return [];
    return await session.mcpAdmin.listServers();
  });
  handle('settings.mcpToggle', async ({ workspaceId, name, enabled }) => {
    const session = mustSession(pool, workspaceId);
    if (!session.mcpAdmin) throw new Error('mcp admin not available');
    if (enabled) await session.mcpAdmin.enableAndAttach(name);
    else await session.mcpAdmin.detach(name);
  });
  handle('settings.vaultEntries', async () => {
    const { readVaultKeys } = await import('./onboarding');
    const home = (await import('node:os')).homedir();
    const names = await readVaultKeys(home);
    return names.map((name) => ({ name }));
  });
  handle('settings.skills', async () => {
    const { listSkills } = await import('./skills');
    return listSkills();
  });
  handle('settings.readSkill', async ({ name }) => {
    const { readSkill } = await import('./skills');
    return readSkill(name);
  });
  handle('settings.writeSkill', async ({ name, body }) => {
    const { writeSkill } = await import('./skills');
    await writeSkill(name, body);
  });
  handle('settings.deleteSkill', async ({ name }) => {
    const { deleteSkill } = await import('./skills');
    await deleteSkill(name);
  });
}

/**
 * Bind a window to the runner pool: forward every supervisor's
 * `connection.changed` to the renderer, manage per-workspace
 * SessionDrivers so streamed events get the right workspaceId tag,
 * and tear everything down when the window closes.
 */
export function bindWindow(pool: RunnerPool, window: BrowserWindow): () => void {
  const send = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  // Maintain one SessionDriver per workspace for the lifetime of its
  // active RemoteSession.
  const localDrivers = new Map<string, SessionDriver>();

  const ensureDriverFor = (id: string, sup: RunnerSupervisor): void => {
    const session = sup.remote();
    const existing = localDrivers.get(id);
    if (existing) existing.dispose();
    if (session) {
      const driver = new SessionDriver(session, window, id);
      localDrivers.set(id, driver);
      drivers.set(id, driver);
    } else {
      localDrivers.delete(id);
      drivers.delete(id);
    }
  };

  const onPoolChange = (id: string): void => {
    const sup = pool.get(id);
    if (!sup) return;
    const phase = sup.snapshot().phase;
    send('connection.changed', { workspaceId: id, phase });
    if (phase.phase === 'connected') ensureDriverFor(id, sup);
    else {
      const existing = localDrivers.get(id);
      if (existing) {
        existing.dispose();
        localDrivers.delete(id);
        drivers.delete(id);
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
    drivers.clear();
  };
}

// ---- internals ----

/** Driver lookup shared across the IPC handlers + bindWindow. Keyed by
 *  workspace id so runTurn / abortTurn target the right runner. */
const drivers = new Map<string, SessionDriver>();

function resolveSupervisor(pool: RunnerPool, workspaceId?: string): RunnerSupervisor | null {
  const id = workspaceId ?? pool.activeWorkspaceId();
  return id ? pool.get(id) : null;
}

function mustSession(pool: RunnerPool, workspaceId?: string): SessionLike {
  return mustRemote(pool, workspaceId) as unknown as SessionLike;
}

function mustRemote(
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
async function waitForSessionState(
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

function mustDriver(workspaceId: string): SessionDriver {
  const driver = drivers.get(workspaceId);
  if (!driver) {
    throw new Error(`no active session for workspace ${workspaceId}`);
  }
  return driver;
}

/**
 * Strongly-typed `ipcMain.handle` — channel + arg shapes come from
 * `IpcCommands` so a renamed command surfaces as a type error.
 */
function handle<K extends IpcCommandName>(
  channel: K,
  fn: (
    ...args: Parameters<IpcCommands[K]>
  ) => Promise<Awaited<ReturnType<IpcCommands[K]>>>,
): void {
  ipcMain.handle(channel, (_evt, ...args) => {
    return fn(...(args as Parameters<IpcCommands[K]>));
  });
}
