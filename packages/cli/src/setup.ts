import * as path from 'node:path';
import * as os from 'node:os';
import {
  Session,
  buildSynthesizeSkillPlugin,
  createAllowListResolver,
  createCallbackResolver,
  createLogger,
  createPluginLoader,
  defaultProjectSkillsDir,
  defaultUserSkillsDir,
  denyByDefaultResolver,
  discoverPlugins,
  discoverSkills,
  loadPreferences,
  PermissionEngine,
  silentLogger,
} from '@moxxy/core';
import type { EmbeddingProvider, PermissionResolver, Plugin } from '@moxxy/sdk';
import { buildConfigPlugin, loadConfig, type EmbeddingsConfig, type MoxxyConfig } from '@moxxy/config';
import { buildSessionConfigApplier } from './config-applier.js';
import { anthropicPlugin } from '@moxxy/plugin-provider-anthropic';
import { openaiPlugin } from '@moxxy/plugin-provider-openai';
import { openaiCodexPlugin } from '@moxxy/plugin-provider-openai-codex';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { toolUseLoopPlugin } from '@moxxy/loop-tool-use';
import { planExecuteLoopPlugin } from '@moxxy/loop-plan-execute';
import { summarizeCompactorPlugin } from '@moxxy/compactor-summarize';
import { BUILTIN_SKILLS_DIR } from '@moxxy/skills-builtin';
import {
  buildVaultPlugin,
  containsPlaceholder,
  resolveValue,
  type VaultStore,
} from '@moxxy/plugin-vault';
import {
  buildMemoryPlugin,
  buildMemoryConsolidatePlugin,
  TfIdfEmbedder,
  type MemoryStore,
} from '@moxxy/plugin-memory';
import { buildTelegramPlugin } from '@moxxy/plugin-telegram';
import { buildMcpAdminPluginWithApi, type McpAdminApi } from '@moxxy/plugin-mcp';
import { cliPlugin } from '@moxxy/plugin-cli';
import { httpChannelPlugin } from '@moxxy/plugin-channel-http';
import { browserPlugin } from '@moxxy/plugin-browser';
import { resolveProviderCredentials } from './provider-credentials.js';

export interface SetupOptions {
  readonly cwd: string;
  readonly verbose?: boolean;
  readonly providerConfig?: Record<string, unknown>;
  readonly resolver?: PermissionResolver;
  readonly model?: string;
  readonly configPath?: string;
  readonly skipUserConfig?: boolean;
  readonly disableKeytar?: boolean;
  /** Skip the interactive API-key prompt when no key is found. Useful for headless tooling that wants a hard error instead of a hang. */
  readonly skipKeyPrompt?: boolean;
  /**
   * If true, treat "no provider key resolvable" as a warning, not a fatal
   * error: setup completes and returns the session with no active provider.
   * Useful for diagnostic commands (`moxxy doctor`, `moxxy plugins list`)
   * that want to inspect everything else even when the user hasn't run init.
   */
  readonly tolerateNoProvider?: boolean;
  /**
   * Skip the provider-activation loop entirely. Used by `moxxy init`, which
   * is itself the place where keys get stored — running the activation
   * loop here would call `vault.get()` for every candidate, opening the
   * vault and triggering a passphrase prompt that hangs an interactive
   * wizard. The session returns with no active provider; callers wire
   * one up themselves (or accept that the session can't run turns yet).
   */
  readonly skipProviderActivation?: boolean;
}

export interface SetupResult {
  readonly session: Session;
  readonly config: MoxxyConfig;
  readonly configSources: ReadonlyArray<{ scope: 'project' | 'user' | 'explicit'; path: string }>;
  readonly vault: VaultStore;
  readonly memory: MemoryStore;
}

export async function setupSession(opts: SetupOptions): Promise<Session> {
  const result = await setupSessionWithConfig(opts);
  return result.session;
}

export async function setupSessionWithConfig(opts: SetupOptions): Promise<SetupResult> {
  const logger = opts.verbose ? createLogger({ minLevel: 'debug' }) : silentLogger;

  const { config: rawConfig, sources } = await loadConfig({
    cwd: opts.cwd,
    explicitPath: opts.configPath,
    skipUser: opts.skipUserConfig,
  });

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

  let config = rawConfig;
  if (containsPlaceholder(rawConfig)) {
    logger.info('resolving vault placeholders in config');
    config = (await resolveValue(rawConfig, vault)) as MoxxyConfig;
  }

  const userPolicyPath =
    config.permissions?.policyPath ?? path.join(os.homedir(), '.moxxy', 'permissions.json');
  const permissionEngine = await PermissionEngine.load(userPolicyPath);

  const session = new Session({
    cwd: opts.cwd,
    logger,
    permissionEngine,
    permissionResolver: opts.resolver ?? denyByDefaultResolver,
    hookTimeoutMs: config.hookTimeoutMs,
    pluginLoader: createPluginLoader({ cwd: opts.cwd }),
  });

  // Build the builtin list first WITHOUT the config plugin so we can pass the
  // whole list to the ConfigApplier (used for hot-toggle of plugin enable/disable).
  const builtinsCore: Array<{ name: string; plugin: Plugin }> = [
    { name: '@moxxy/plugin-provider-anthropic', plugin: anthropicPlugin },
    { name: '@moxxy/plugin-provider-openai', plugin: openaiPlugin },
    { name: '@moxxy/plugin-provider-openai-codex', plugin: openaiCodexPlugin },
    { name: '@moxxy/tools-builtin', plugin: builtinToolsPlugin },
    { name: '@moxxy/loop-tool-use', plugin: toolUseLoopPlugin },
    { name: '@moxxy/loop-plan-execute', plugin: planExecuteLoopPlugin },
    { name: '@moxxy/compactor-summarize', plugin: summarizeCompactorPlugin },
    { name: '@moxxy/plugin-vault', plugin: vaultPlugin },
    { name: '@moxxy/plugin-memory', plugin: memoryPlugin },
    {
      name: '@moxxy/memory-consolidate',
      plugin: buildMemoryConsolidatePlugin(memory, () => session.providers.getActive()),
    },
    { name: '@moxxy/plugin-cli', plugin: cliPlugin },
    { name: '@moxxy/plugin-channel-http', plugin: httpChannelPlugin },
    { name: '@moxxy/plugin-telegram', plugin: buildTelegramPlugin({ vault }) },
    { name: '@moxxy/plugin-browser', plugin: browserPlugin },
    // Admin tools (mcp_add_server, mcp_list_servers, mcp_remove_server,
    // mcp_test_server) plus the boot-time lazy attach. Passing the
    // session's live tool registry enables both hot-attach for runtime
    // adds AND lazy stub registration in onInit for saved servers.
    (() => {
      const { plugin, api } = buildMcpAdminPluginWithApi({
        toolRegistry: session.tools,
        skillRegistry: session.skills,
        userSkillsDir: rawConfig.skills?.userDir,
      });
      // Stash the api on the session so the TUI / CLI can call
      // enableAndAttach + detach without going through the model. Loose
      // typing — `mcpAdmin` isn't part of Session's declared shape.
      (session as unknown as { mcpAdmin: McpAdminApi }).mcpAdmin = api;
      return { name: '@moxxy/plugin-mcp-admin', plugin };
    })(),
    {
      name: '@moxxy/synthesize-skill',
      // Thread the SAME directory set the boot scan uses so reload_skills
      // doesn't drop builtin/plugin skills when invoked at runtime.
      plugin: buildSynthesizeSkillPlugin(session, {
        builtinDir: BUILTIN_SKILLS_DIR,
        ...(rawConfig.skills?.extraDirs ? { pluginDirs: rawConfig.skills.extraDirs } : {}),
        ...(rawConfig.skills?.projectDir ? { projectDir: rawConfig.skills.projectDir } : {}),
        ...(rawConfig.skills?.userDir ? { userDir: rawConfig.skills.userDir } : {}),
      }),
    },
  ];

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

  const registered = new Set<string>();
  for (const { name, plugin } of builtins) {
    if (config.plugins?.[name]?.enabled === false) {
      logger.info('skipping disabled plugin', { plugin: name });
      continue;
    }
    session.pluginHost.registerStatic(plugin);
    registered.add(plugin.name);
  }

  // Auto-discover any installed @moxxy/plugin-* (or user-authored) packages
  // that declare a `moxxy.plugin` manifest in their package.json. Skips
  // anything we already registered statically above; respects
  // config.plugins[pkgName].enabled. Failures are logged, not fatal.
  const loader = createPluginLoader({ cwd: opts.cwd });
  const userPluginsDir = path.join(os.homedir(), '.moxxy', 'plugins');
  try {
    const manifests = await discoverPlugins({
      cwd: opts.cwd,
      logger,
      extraPaths: [userPluginsDir],
    });
    for (const manifest of manifests) {
      if (registered.has(manifest.packageName)) continue;
      if (config.plugins?.[manifest.packageName]?.enabled === false) {
        logger.info('skipping disabled plugin', { plugin: manifest.packageName });
        continue;
      }
      try {
        const plugin = await loader.load(manifest);
        if (registered.has(plugin.name)) continue;
        session.pluginHost.registerStatic(plugin);
        registered.add(plugin.name);
        logger.info('auto-loaded plugin', { plugin: plugin.name, from: manifest.packagePath });
      } catch (err) {
        logger.warn('auto-discovery: failed to load plugin', {
          package: manifest.packageName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('auto-discovery: scan failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const primaryProvider = config.provider?.name ?? 'anthropic';
  const initialProviderConfig = { ...(config.provider?.config ?? {}), ...(opts.providerConfig ?? {}) };
  const fallbacks = config.provider?.fallbacks ?? [];
  const candidates = [primaryProvider, ...fallbacks];

  let activated: { name: string; cfg: Record<string, unknown> } | null = null;
  let lastErr: unknown = null;
  if (opts.skipProviderActivation) {
    logger.info('skipping provider activation (skipProviderActivation set)');
  } else for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    // Only the FIRST candidate gets the interactive prompt — chaining
    // through fallbacks via prompts would be confusing.
    const interactive = i === 0 && !opts.skipKeyPrompt && process.stdin.isTTY === true;
    try {
      const resolved = await resolveProviderCredentials(candidate, vault, {
        providerConfig: i === 0 ? initialProviderConfig : {},
        interactive,
      });
      activated = { name: candidate, cfg: resolved };
      break;
    } catch (err) {
      lastErr = err;
      logger.warn('provider key resolution failed; trying fallback', {
        provider: candidate,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!activated) {
    if (opts.tolerateNoProvider || opts.skipProviderActivation) {
      logger.warn('no provider key resolvable; continuing without an active provider', {
        tried: candidates,
        err: lastErr instanceof Error ? lastErr.message : String(lastErr),
      });
    } else {
      throw new Error(
        `No working provider key. Tried: ${candidates.join(', ')}. ` +
          `Run \`moxxy init\` in an interactive terminal, set env vars, or store ` +
          `keys in the vault. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }
  } else {
    session.providers.setActive(activated.name, activated.cfg);
    if (activated.name !== primaryProvider) {
      logger.warn('using fallback provider', { primary: primaryProvider, active: activated.name });
    }
  }

  // Probe each registered provider for credential readiness so the TUI
  // /model picker can flag unconfigured ones. Non-interactive — silent
  // failures leave the provider out of the ready set. The currently
  // activated provider is auto-included.
  const readyProviders = new Set<string>();
  if (activated) readyProviders.add(activated.name);
  for (const p of session.providers.list()) {
    if (readyProviders.has(p.name)) continue;
    try {
      await resolveProviderCredentials(p.name, vault, { interactive: false });
      readyProviders.add(p.name);
    } catch {
      // not ready — leave out
    }
  }
  (session as unknown as { readyProviders: Set<string> }).readyProviders = readyProviders;

  // Expose a credential resolver so runtime provider switches (TUI
  // /model picker, preference re-apply below) can re-resolve credentials
  // before calling setActive — otherwise the new provider gets
  // createClient({}) and OAuth-backed providers (openai-codex) throw
  // "no credentials" on the next turn.
  const credentialResolver = async (providerName: string): Promise<Record<string, unknown>> => {
    return resolveProviderCredentials(providerName, vault, { interactive: false });
  };
  (session as unknown as { credentialResolver: typeof credentialResolver }).credentialResolver =
    credentialResolver;

  if (config.loop) {
    session.loops.setActive(config.loop);
  }

  if (config.compactor) {
    session.compactors.setActive(config.compactor);
  }

  // Apply persisted runtime preferences (~/.moxxy/preferences.json).
  // Order matters: provider must activate first (so its model list is
  // available for the model field), then loop. We silently skip any
  // pref that no longer references a registered plugin — a stale
  // preference from a previous moxxy version shouldn't break boot.
  try {
    const prefs = await loadPreferences();
    if (prefs.providerName && session.providers.list().some((p) => p.name === prefs.providerName)) {
      try {
        if (session.providers.getActiveName() !== prefs.providerName) {
          // Resolve credentials before switching — otherwise OAuth-backed
          // providers (openai-codex) get createClient({}) and throw on
          // the next turn.
          const cfg = await credentialResolver(prefs.providerName);
          session.providers.setActive(prefs.providerName, cfg);
        }
      } catch (err) {
        logger.warn('failed to apply preferred provider', {
          providerName: prefs.providerName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (prefs.loopStrategy && session.loops.list().some((s) => s.name === prefs.loopStrategy)) {
      try {
        session.loops.setActive(prefs.loopStrategy);
      } catch (err) {
        logger.warn('failed to apply preferred loop strategy', {
          loopStrategy: prefs.loopStrategy,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Note: the persisted `model` is applied by the TUI / one-shot
    // entrypoints (they own which model gets passed to runTurn). We
    // surface it via the returned config so callers can pick it up.
  } catch (err) {
    // Preferences are best-effort; never block session boot on them.
    logger.warn('failed to load preferences', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const discovered = await discoverSkills({
    projectDir: config.skills?.projectDir ?? defaultProjectSkillsDir(opts.cwd),
    userDir: config.skills?.userDir ?? defaultUserSkillsDir(),
    pluginDirs: config.skills?.extraDirs,
    builtinDir: BUILTIN_SKILLS_DIR,
    logger,
  });
  for (const skill of discovered) session.skills.register(skill);

  // Fire onInit lifecycle hooks now that every plugin is registered and
  // every skill is loaded. Hooks observe the fully-populated session
  // and can do session-level setup (e.g. the MCP admin plugin registers
  // lazy stubs for saved servers here). Failures are non-fatal — the
  // dispatcher records them as ErrorEvents but startup proceeds.
  await session.dispatcher.dispatchInit(session.appContext());

  return { session, config, configSources: sources, vault, memory };
}

export { createAllowListResolver, createCallbackResolver, denyByDefaultResolver };

/**
 * Build the configured EmbeddingProvider. `undefined` and `'tfidf'` both yield
 * the built-in TfIdfEmbedder (zero deps). `'none'` returns `null` so the
 * MemoryStore falls back to keyword recall. `'openai'` and `'transformers'`
 * dynamically import their plugins so users without one or the other
 * installed don't pay the load cost.
 */
async function buildEmbedder(
  cfg: EmbeddingsConfig | undefined,
  logger: { warn(msg: string, meta?: Record<string, unknown>): void },
): Promise<EmbeddingProvider | null | undefined> {
  if (!cfg || cfg.provider === 'tfidf') return new TfIdfEmbedder();
  if (cfg.provider === 'none') return null;
  if (cfg.provider === 'openai') {
    try {
      const mod = (await import('@moxxy/plugin-embeddings-openai')) as {
        createOpenAIEmbedder: (opts: Record<string, unknown>) => EmbeddingProvider;
      };
      return mod.createOpenAIEmbedder({
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.dimensions !== undefined ? { dimensions: cfg.dimensions } : {}),
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.batchSize !== undefined ? { batchSize: cfg.batchSize } : {}),
      });
    } catch (err) {
      logger.warn('failed to load @moxxy/plugin-embeddings-openai; falling back to TF-IDF', {
        err: err instanceof Error ? err.message : String(err),
      });
      return new TfIdfEmbedder();
    }
  }
  if (cfg.provider === 'transformers') {
    try {
      const mod = (await import('@moxxy/plugin-embeddings-transformers')) as {
        createTransformersEmbedder: (opts: Record<string, unknown>) => EmbeddingProvider;
      };
      return mod.createTransformersEmbedder({
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.dimensions !== undefined ? { dimensions: cfg.dimensions } : {}),
        ...(cfg.cacheDir ? { cacheDir: cfg.cacheDir } : {}),
      });
    } catch (err) {
      logger.warn('failed to load @moxxy/plugin-embeddings-transformers; falling back to TF-IDF', {
        err: err instanceof Error ? err.message : String(err),
      });
      return new TfIdfEmbedder();
    }
  }
  return new TfIdfEmbedder();
}
