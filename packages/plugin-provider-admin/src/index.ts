import { defineTool, definePlugin, type Plugin, type ProviderDef, z } from '@moxxy/sdk';
import { buildProviderDef, validateOpenAICompatKey } from './factory.js';
import {
  providersConfigPath,
  readProvidersConfig,
  removeStoredProvider,
  upsertStoredProvider,
} from './store.js';
import type { StoredProvider } from './types.js';

export { providersConfigPath, readProvidersConfig, upsertStoredProvider, removeStoredProvider };
export type { StoredProvider, StoredProviderOpenAICompat, StoredProvidersConfig } from './types.js';
export { buildProviderDef, validateOpenAICompatKey } from './factory.js';

/**
 * Minimal subset of the in-process ProviderRegistry the admin plugin
 * needs. Keeping the surface narrow lets us pass either the live
 * `session.providers` from the CLI or a fake from tests.
 */
export interface ProviderRegistryLike {
  register(def: ProviderDef): void;
  replace(def: ProviderDef): void;
  unregister(name: string): void;
  list(): ReadonlyArray<ProviderDef>;
}

export interface BuildProviderAdminPluginOptions {
  /** Live provider registry — the plugin (un)registers stored defs against it. */
  readonly providerRegistry: ProviderRegistryLike;
  /** Override the on-disk path. Tests inject a tmp file here. */
  readonly configPath?: string;
}

const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]*$/;

const providerNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(PROVIDER_NAME_RE, 'name must be slug-like (lowercase letters, digits, hyphens; must start with a letter)');

const modelDescriptorSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().default(true),
  supportsStreaming: z.boolean().default(true),
  supportsImages: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
});

const addProviderInput = z.object({
  kind: z
    .enum(['openai-compat'])
    .default('openai-compat')
    .describe(
      'Wire-protocol family the vendor speaks. "openai-compat" reuses the moxxy ' +
        'OpenAI client against a vendor baseURL (z.ai, deepseek, groq, openrouter, …). ' +
        'Native-SDK vendors must ship as a dedicated plugin instead.',
    ),
  name: providerNameSchema.describe('Provider slug. Becomes the registry key + canonical vault entry (<NAME>_API_KEY).'),
  baseURL: z
    .string()
    .url()
    .describe('Vendor API base URL, e.g. https://api.z.ai/api/coding/paas/v4.'),
  defaultModel: z.string().min(1).describe('Model id used when a request does not pin one explicitly.'),
  models: z
    .array(modelDescriptorSchema)
    .min(1)
    .describe('Models the vendor exposes. Powers /model autocomplete and the setup wizard.'),
  envVar: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional()
    .describe('Override the API-key env-var name (defaults to <NAME>_API_KEY).'),
});

const removeProviderInput = z.object({
  name: providerNameSchema,
});

const testProviderInput = z.object({
  baseURL: z.string().url(),
  apiKey: z.string().min(1),
});

export function buildProviderAdminPlugin(opts: BuildProviderAdminPluginOptions): Plugin {
  const { providerRegistry, configPath } = opts;

  return definePlugin({
    name: '@moxxy/plugin-provider-admin',
    version: '0.0.0',
    tools: [
      defineTool({
        name: 'provider_add',
        description:
          'Register an OpenAI-compatible LLM provider (z.ai, deepseek, groq, openrouter, fireworks, ' +
          'together, mistral, …) with moxxy. Wraps the in-process OpenAI client with the vendor baseURL + ' +
          'a user-supplied models list. Persists to ~/.moxxy/providers.json so the provider survives ' +
          'restarts. The new provider is registered in the LIVE session — switch to it with /provider ' +
          'or set it as the default in moxxy.config.ts.',
        inputSchema: addProviderInput,
        permission: { action: 'prompt' },
        handler: async (input) => {
          const entry: StoredProvider = {
            kind: 'openai-compat',
            name: input.name,
            baseURL: input.baseURL,
            defaultModel: input.defaultModel,
            models: input.models,
            ...(input.envVar ? { envVar: input.envVar } : {}),
            createdAt: new Date().toISOString(),
          };
          if (!entry.models.some((m) => m.id === entry.defaultModel)) {
            throw new Error(
              `provider_add: defaultModel "${entry.defaultModel}" is not in the models list. ` +
                `Add it to the array or pick one of: ${entry.models.map((m) => m.id).join(', ')}.`,
            );
          }
          const def = buildProviderDef(entry);
          const wasRegistered = providerRegistry.list().some((p) => p.name === entry.name);
          if (wasRegistered) providerRegistry.replace(def);
          else providerRegistry.register(def);
          try {
            await upsertStoredProvider(entry, configPath);
          } catch (err) {
            // Roll back the runtime registration so the next boot
            // doesn't see a phantom that isn't on disk.
            providerRegistry.unregister(entry.name);
            throw err;
          }
          return {
            ok: true,
            name: entry.name,
            kind: entry.kind,
            baseURL: entry.baseURL,
            defaultModel: entry.defaultModel,
            models: entry.models.map((m) => m.id),
            path: configPath ?? providersConfigPath(),
            replaced: wasRegistered,
            note:
              `Provider "${entry.name}" is live in this session. ` +
              `Have the USER store the API key by running: /vault set ${(entry.envVar ?? `${entry.name.toUpperCase()}_API_KEY`)} <key> ` +
              `— never ask them to paste the key to you. ` +
              `Switch with the /provider command or set provider.name in moxxy.config.ts.`,
          };
        },
      }),
      defineTool({
        name: 'provider_list',
        description:
          'List user-registered providers (persisted in ~/.moxxy/providers.json) plus their default model and base URL. ' +
          'Built-in providers (anthropic, openai, openai-codex) are NOT included — query session.providers for those.',
        inputSchema: z.object({}),
        handler: async () => {
          const cfg = await readProvidersConfig(configPath);
          return {
            path: configPath ?? providersConfigPath(),
            providers: cfg.providers.map((p) => ({
              name: p.name,
              kind: p.kind,
              baseURL: p.baseURL,
              defaultModel: p.defaultModel,
              models: p.models.map((m) => m.id),
              envVar: p.envVar ?? `${p.name.toUpperCase()}_API_KEY`,
            })),
          };
        },
      }),
      defineTool({
        name: 'provider_remove',
        description:
          'Remove a previously-added provider from ~/.moxxy/providers.json and detach it from the live session. ' +
          'Does NOT delete the stored API key — call vault_delete name=<NAME>_API_KEY separately if you also want to drop the credential.',
        inputSchema: removeProviderInput,
        permission: { action: 'prompt' },
        handler: async ({ name }) => {
          const removed = await removeStoredProvider(name, configPath);
          if (!removed) {
            return { ok: false, name, note: `No stored provider named "${name}".` };
          }
          try {
            providerRegistry.unregister(name);
          } catch {
            // Already gone in the live registry — best effort.
          }
          return { ok: true, name, note: `Removed "${name}" from providers.json and detached from session.` };
        },
      }),
      defineTool({
        name: 'provider_test',
        description:
          'Probe an OpenAI-compatible endpoint with the supplied API key by calling /v1/models. ' +
          'Use BEFORE provider_add to confirm the baseURL + key are valid. Returns { ok: true } on success or ' +
          '{ ok: false, message } with the vendor error verbatim.',
        inputSchema: testProviderInput,
        permission: { action: 'prompt' },
        handler: async ({ baseURL, apiKey }) => validateOpenAICompatKey(apiKey, baseURL),
      }),
    ],
    hooks: {
      onInit: async (ctx) => {
        const log = (ctx as { logger?: { warn: (msg: string, meta?: unknown) => void } }).logger;
        let cfg;
        try {
          cfg = await readProvidersConfig(configPath);
        } catch (err) {
          log?.warn?.('provider-admin: failed to read providers.json', {
            err: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        for (const entry of cfg.providers) {
          try {
            const def = buildProviderDef(entry);
            const already = providerRegistry.list().some((p) => p.name === entry.name);
            if (already) providerRegistry.replace(def);
            else providerRegistry.register(def);
          } catch (err) {
            log?.warn?.(`provider-admin: failed to register "${entry.name}"`, {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    },
  });
}
