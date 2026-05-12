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
  PermissionEngine,
  silentLogger,
} from '@moxxy/core';
import type { EmbeddingProvider, PermissionResolver, Plugin } from '@moxxy/sdk';
import { buildConfigPlugin, loadConfig, type EmbeddingsConfig, type MoxxyConfig } from '@moxxy/config';
import { buildSessionConfigApplier } from './config-applier.js';
import { anthropicPlugin } from '@moxxy/plugin-provider-anthropic';
import { openaiPlugin } from '@moxxy/plugin-provider-openai';
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
import { cliPlugin } from '@moxxy/plugin-cli';
import { httpChannelPlugin } from '@moxxy/plugin-channel-http';
import { browserPlugin } from '@moxxy/plugin-browser';
import { resolveProviderApiKey } from './provider-keys.js';

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
    { name: '@moxxy/synthesize-skill', plugin: buildSynthesizeSkillPlugin(session) },
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
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    // Only the FIRST candidate gets the interactive prompt — chaining
    // through fallbacks via prompts would be confusing.
    const interactive = i === 0 && !opts.skipKeyPrompt && process.stdin.isTTY === true;
    try {
      const { providerConfig: resolved } = await resolveProviderApiKey(candidate, vault, {
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
    if (opts.tolerateNoProvider) {
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

  if (config.loop) {
    session.loops.setActive(config.loop);
  }

  if (config.compactor) {
    session.compactors.setActive(config.compactor);
  }

  const discovered = await discoverSkills({
    projectDir: config.skills?.projectDir ?? defaultProjectSkillsDir(opts.cwd),
    userDir: config.skills?.userDir ?? defaultUserSkillsDir(),
    pluginDirs: config.skills?.extraDirs,
    builtinDir: BUILTIN_SKILLS_DIR,
    logger,
  });
  for (const skill of discovered) session.skills.register(skill);

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
