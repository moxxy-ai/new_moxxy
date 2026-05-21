import type { Session } from '@moxxy/core';
import {
  createAllowListResolver,
  createCallbackResolver,
  createLogger,
  defaultProjectSkillsDir,
  defaultUserSkillsDir,
  denyByDefaultResolver,
  discoverSkills,
  silentLogger,
} from '@moxxy/core';
import type { Plugin } from '@moxxy/sdk';
import { buildConfigPlugin } from '@moxxy/config';
import { BUILTIN_SKILLS_DIR } from '@moxxy/skills-builtin';
import { buildVaultPlugin } from '@moxxy/plugin-vault';
import { buildMemoryPlugin } from '@moxxy/plugin-memory';
import { buildSessionConfigApplier } from './config-applier.js';
import { loadRawConfig, resolveConfigPlaceholders } from './setup/load-config.js';
import { buildEmbedder } from './setup/embedder.js';
import { buildSession } from './setup/build-session.js';
import { buildBuiltinsCore } from './setup/builtins.js';
import { buildSchedulerRunner } from './setup/scheduler-runner.js';
import { buildWebhookRunner } from './setup/webhook-runner.js';
import { registerPlugins } from './setup/register-plugins.js';
import { activateProvider } from './setup/activate-provider.js';
import { applyPreferences } from './setup/apply-preferences.js';
import { attachSessionPersistence } from './setup/persistence.js';
import type { BootStep, SetupOptions, SetupResult } from './setup/types.js';

export type { BootStep, SetupOptions, SetupResult } from './setup/types.js';

export async function setupSession(opts: SetupOptions): Promise<Session> {
  const result = await setupSessionWithConfig(opts);
  return result.session;
}

export async function setupSessionWithConfig(opts: SetupOptions): Promise<SetupResult> {
  const logger = opts.verbose ? createLogger({ minLevel: 'debug' }) : silentLogger;
  // When the TUI bootstrap path passes onProgress, it owns raw mode —
  // a vault/key prompt would deadlock. Force skipKeyPrompt to surface
  // missing-credential errors as a visible boot-failure row instead.
  const skipKeyPrompt = opts.skipKeyPrompt || opts.onProgress != null;
  const progress = opts.onProgress ?? ((): void => undefined);

  const { rawConfig, sources } = await loadRawConfig({
    cwd: opts.cwd,
    configPath: opts.configPath,
    skipUser: opts.skipUserConfig,
  });
  progress({ kind: 'config-loaded', sources: sources.length });

  const { plugin: vaultPlugin, vault } = buildVaultPlugin({ disableKeytar: opts.disableKeytar });
  const embedder = await buildEmbedder(rawConfig.embeddings, logger);
  const { plugin: memoryPlugin, store: memory } = buildMemoryPlugin({ embedder });

  // MCP servers are now lazy-loaded: the admin plugin's onInit hook
  // reads ~/.moxxy/mcp.json and registers stub tools using each
  // server's cached descriptors WITHOUT connecting. The actual MCP
  // connection happens on the first invocation of a tool from that
  // server. Boot stays instant even with many servers configured.
  //
  // Servers that have never been added before lack the descriptor
  // cache; for those the user re-runs mcp_add_server (or
  // mcp_test_server) and the cache populates.

  const config = await resolveConfigPlaceholders(rawConfig, vault, logger);

  const session = await buildSession({
    cwd: opts.cwd,
    config,
    resolver: opts.resolver,
    resumeSessionId: opts.resumeSessionId,
    logger,
  });

  // Build the builtin list first WITHOUT the config plugin so we can pass the
  // whole list to the ConfigApplier (used for hot-toggle of plugin enable/disable).
  const schedulerRunner = buildSchedulerRunner(session);
  const webhookRunner = buildWebhookRunner(session);
  const { entries: builtinsCore, scheduler, webhooks, security } = buildBuiltinsCore({
    session,
    rawConfig,
    vault,
    vaultPlugin,
    memory,
    memoryPlugin,
    schedulerRunner,
    webhookRunner,
    logger,
  });

  const builtins: Array<{ name: string; plugin: Plugin }> = [
    ...builtinsCore,
    {
      name: '@moxxy/plugin-config',
      plugin: buildConfigPlugin({
        cwd: opts.cwd,
        applier: buildSessionConfigApplier(session, config, builtinsCore),
      }),
    },
  ];

  const pluginRegistration = await registerPlugins(session, config, builtins, opts.cwd, logger);
  progress({
    kind: 'plugins-registered',
    count: pluginRegistration.registered.size,
    skipped: pluginRegistration.skipped.length,
  });

  const { credentialResolver } = await activateProvider({
    session,
    config,
    vault,
    providerConfig: { ...(config.provider?.config ?? {}), ...(opts.providerConfig ?? {}) },
    skipKeyPrompt,
    skipProviderActivation: opts.skipProviderActivation,
    tolerateNoProvider: opts.tolerateNoProvider,
    onProgress: opts.onProgress,
    progress,
    logger,
  });

  if (config.loop) session.loops.setActive(config.loop);
  if (config.compactor) session.compactors.setActive(config.compactor);

  await applyPreferences(session, credentialResolver, logger);
  progress({ kind: 'prefs-applied' });

  const discovered = await discoverSkills({
    projectDir: config.skills?.projectDir ?? defaultProjectSkillsDir(opts.cwd),
    userDir: config.skills?.userDir ?? defaultUserSkillsDir(),
    pluginDirs: config.skills?.extraDirs,
    builtinDir: BUILTIN_SKILLS_DIR,
    logger,
  });
  for (const skill of discovered) session.skills.register(skill);
  progress({ kind: 'skills-loaded', count: discovered.length });

  // Fire onInit lifecycle hooks now that every plugin is registered and
  // every skill is loaded. Hooks observe the fully-populated session
  // and can do session-level setup (e.g. the MCP admin plugin registers
  // lazy stubs for saved servers here). Failures are non-fatal — the
  // dispatcher records them as ErrorEvents but startup proceeds.
  await session.dispatcher.dispatchInit(session.appContext());
  progress({ kind: 'init-hooks-done' });
  progress({ kind: 'ready' });

  const persistence = attachSessionPersistence(session, opts.cwd, opts.disableSessionPersistence);

  return {
    session,
    config,
    configSources: sources,
    vault,
    memory,
    scheduler,
    webhooks,
    persistence,
    security,
    pluginRegistration,
  };
}

export { createAllowListResolver, createCallbackResolver, denyByDefaultResolver };
