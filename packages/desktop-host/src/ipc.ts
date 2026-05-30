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
} from '@moxxy/desktop-ipc-contract';
import { validateIpcInput } from '@moxxy/desktop-ipc-contract/validation';
import type { SessionLike } from '@moxxy/sdk';
import { RunnerSupervisor } from './runner-supervisor';
import { RunnerPool, UNBOUND_ID } from './runner-pool';
import { probeOnboarding, saveProviderKey } from './onboarding';
import { installMoxxyCli, probeNode } from './installer';
import { SessionDriver } from './session-driver';
import { DeskStore } from './desks';
import { dialog, shell, BrowserWindow as BrowserWindowApi } from 'electron';
import { buildInProcessPlugins, type InProcessPlugins } from './in-process-plugins';
import { assertSafeExternalUrl } from './security';
import { answerAsk } from './ask-broker';

/**
 * Lazily-built bag of in-process plugins (Codex transcriber today,
 * extensible to more). Built on first access so the cost of the
 * keychain / vault probe is paid only when the user actually exercises
 * one of these capabilities. Re-used across IPC calls so the
 * underlying VaultStore caches its master key.
 */
let pluginsCache: InProcessPlugins | null = null;
function getInProcessPlugins(): InProcessPlugins {
  if (!pluginsCache) pluginsCache = buildInProcessPlugins();
  return pluginsCache;
}

export function registerIpcHandlers(pool: RunnerPool, desks: DeskStore): void {
  // ---- Interactive ask (permission/approval bottom sheet) ------------------

  handle('ask.respond', async ({ requestId, response }) => {
    answerAsk(requestId, response);
  });

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
    assertSafeExternalUrl(url);
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
  handle('session.runTurn', async ({ workspaceId, prompt, model, attachments }) => {
    const id = workspaceId ?? pool.activeWorkspaceId();
    if (!id) throw new Error('no active workspace');
    const driver = mustDriver(id);
    return driver.runTurn(prompt, model, attachments);
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
    // Voice is wired through the desktop's *in-process* Codex
    // transcriber (mirrors the TUI's self-host setup: same vault,
    // same plugin class). Affordance gating: probe the vault for
    // ANY entry under the Codex OAuth namespace
    // (`oauth/openai-codex/*`) — same key prefix the Codex login
    // command writes to. If something's stored, the user has a
    // login → show the mic.
    try {
      const { vault } = getInProcessPlugins();
      // Stored Codex creds are written under `oauth/openai-codex/...`
      // by `moxxy login openai-codex`. We check the canonical
      // refresh-token key; the transcriber's own resolver does the
      // detailed validation when transcribe() is called.
      const refresh = await vault.get('oauth/openai-codex/refresh_token');
      return refresh != null;
    } catch {
      return false;
    }
  });
  handle('session.transcribe', async ({ audioBase64, mimeType }) => {
    // Run the transcribe through the in-process Codex transcriber —
    // same plugin class, same vault, identical to the TUI's voice
    // path. No round-trip through the runner socket needed (and no
    // RemoteSession.setActive throw to work around).
    const { transcriber } = getInProcessPlugins();
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
      // Restrict to what the agent can actually use: images + text/code.
      // buildAttachments is the real gate (it drops binary/oversized), but
      // the filter steers the picker so the user doesn't pick a 4 GB video.
      filters: [
        {
          name: 'Attachable files',
          extensions: [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
            'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'sql',
            'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
            'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'html', 'css', 'scss',
            'xml', 'toml', 'ini', 'env', 'conf',
          ],
        },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All files', extensions: ['*'] },
      ],
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
  handle('settings.vaultSet', async ({ name, value }) => {
    // Writes to the same on-disk vault the runner reads (shared file +
    // key source via the in-process vault plugin), so a key added here is
    // immediately resolvable as ${vault:NAME}.
    await getInProcessPlugins().vault.set(name, value);
  });
  handle('settings.vaultDelete', async ({ name }) => {
    await getInProcessPlugins().vault.delete(name);
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

  // ---- Chat transcript log (append-only NDJSON) ---------------------------

  handle('chat.append', async ({ workspaceId, events }) => {
    const { appendEvents } = await import('./chat-log');
    await appendEvents(workspaceId, events);
  });
  handle('chat.loadSegment', async ({ workspaceId, before, limit }) => {
    const { loadSegment } = await import('./chat-log');
    return loadSegment(workspaceId, before, limit);
  });
  handle('chat.clearLog', async ({ workspaceId }) => {
    const { clearLog } = await import('./chat-log');
    await clearLog(workspaceId);
  });
  handle('chat.listWorkspaces', async () => {
    const { listWorkspaces } = await import('./chat-log');
    return listWorkspaces();
  });
  handle('chat.migrate', async ({ workspaces }) => {
    const { migrate } = await import('./chat-log');
    await migrate(workspaces);
  });
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
      // Primary: own the driver as before.
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
    // Runtime-validate the payload at the boundary before any handler
    // touches the filesystem / a child process / the vault. Schemas
    // exist only for the security-sensitive commands; the rest pass
    // through (validateIpcInput is a no-op without a schema).
    validateIpcInput(channel, args[0]);
    return fn(...(args as Parameters<IpcCommands[K]>));
  });
}
