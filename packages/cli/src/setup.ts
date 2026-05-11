import * as path from 'node:path';
import * as os from 'node:os';
import {
  Session,
  buildSynthesizeSkillPlugin,
  createAllowListResolver,
  createCallbackResolver,
  createLogger,
  defaultProjectSkillsDir,
  defaultUserSkillsDir,
  denyByDefaultResolver,
  discoverSkills,
  PermissionEngine,
  silentLogger,
} from '@moxxy/core';
import type { EmbeddingProvider, PermissionResolver, Plugin } from '@moxxy/sdk';
import { loadConfig, type EmbeddingsConfig, type MoxxyConfig } from '@moxxy/config';
import { anthropicPlugin } from '@moxxy/plugin-provider-anthropic';
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
import { buildMemoryPlugin, TfIdfEmbedder, type MemoryStore } from '@moxxy/plugin-memory';
import { buildTelegramPlugin } from '@moxxy/plugin-telegram';
import { cliPlugin } from '@moxxy/plugin-cli';
import { httpChannelPlugin } from '@moxxy/plugin-channel-http';

export interface SetupOptions {
  readonly cwd: string;
  readonly verbose?: boolean;
  readonly providerConfig?: Record<string, unknown>;
  readonly resolver?: PermissionResolver;
  readonly model?: string;
  readonly configPath?: string;
  readonly skipUserConfig?: boolean;
  readonly disableKeytar?: boolean;
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
  });

  const builtins: Array<{ name: string; plugin: Plugin }> = [
    { name: '@moxxy/plugin-provider-anthropic', plugin: anthropicPlugin },
    { name: '@moxxy/tools-builtin', plugin: builtinToolsPlugin },
    { name: '@moxxy/loop-tool-use', plugin: toolUseLoopPlugin },
    { name: '@moxxy/loop-plan-execute', plugin: planExecuteLoopPlugin },
    { name: '@moxxy/compactor-summarize', plugin: summarizeCompactorPlugin },
    { name: '@moxxy/plugin-vault', plugin: vaultPlugin },
    { name: '@moxxy/plugin-memory', plugin: memoryPlugin },
    { name: '@moxxy/plugin-cli', plugin: cliPlugin },
    { name: '@moxxy/plugin-channel-http', plugin: httpChannelPlugin },
    { name: '@moxxy/plugin-telegram', plugin: buildTelegramPlugin({ vault }) },
    { name: '@moxxy/synthesize-skill', plugin: buildSynthesizeSkillPlugin(session) },
  ];

  for (const { name, plugin } of builtins) {
    if (config.plugins?.[name]?.enabled === false) {
      logger.info('skipping disabled plugin', { plugin: name });
      continue;
    }
    session.pluginHost.registerStatic(plugin);
  }

  const providerName = config.provider?.name ?? 'anthropic';
  const providerConfig = { ...(config.provider?.config ?? {}), ...(opts.providerConfig ?? {}) };
  session.providers.setActive(providerName, providerConfig);

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
