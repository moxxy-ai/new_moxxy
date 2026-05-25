import { z } from 'zod';

export const watcherModeSchema = z.enum(['auto', 'manual', 'off']);

export const pluginSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const providerSettingsSchema = z.object({
  name: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  /**
   * Ordered list of provider names to fall back to when the primary's API key
   * resolution fails. The first one with a working key wins.
   */
  fallbacks: z.array(z.string()).optional(),
});

export const permissionsConfigSchema = z.object({
  policyPath: z.string().optional(),
  allow: z
    .array(
      z.object({
        name: z.string(),
        inputMatches: z.record(z.string(), z.string()).optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  deny: z
    .array(
      z.object({
        name: z.string(),
        inputMatches: z.record(z.string(), z.string()).optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});

export const securityConfigSchema = z.object({
  /**
   * Master toggle. When false (the default), `@moxxy/plugin-security`
   * is a no-op even if registered — every tool runs exactly as it does
   * without the plugin. Per-tool `isolation: { ... }` declarations
   * remain as documentation but are not enforced.
   */
  enabled: z.boolean(),
  /**
   * Name of the Isolator implementation to use as default. Phase 1
   * ships `none` (passthrough) and `inproc` (cap validation + timeout).
   * Future isolators (`worker`, `subprocess`, `wasm`, `docker`) register
   * by name via the same plugin contract and slot in here.
   */
  isolator: z.string().optional(),
  /**
   * Per-tool isolator overrides keyed by tool name. e.g.
   * `{ bash: 'subprocess', memory_save: 'none' }`. Falls back to the
   * default isolator above when a tool isn't listed.
   */
  perTool: z.record(z.string(), z.string()).optional(),
  /**
   * Per-plugin isolator overrides keyed by plugin name. Applies to
   * every tool the plugin contributes unless overridden in `perTool`.
   */
  perPlugin: z.record(z.string(), z.string()).optional(),
  /**
   * When true, tools without a declared `isolation` field are denied
   * outright (instead of falling through to the default isolator).
   * Useful for hardening once every in-use tool has been audited.
   */
  requireDeclaration: z.boolean().optional(),
});

export const embeddingsConfigSchema = z.object({
  /**
   * 'tfidf' (default, zero deps) | 'openai' (text-embedding-3-*)
   * | 'transformers' (local, @huggingface/transformers) | 'none' (disable).
   */
  provider: z.enum(['tfidf', 'openai', 'transformers', 'none']),
  model: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  apiKey: z.string().optional(),
  batchSize: z.number().int().positive().optional(),
  cacheDir: z.string().optional(),
  /** Persist computed embeddings to ~/.moxxy/memory/.embeddings.json. */
  persistIndex: z.boolean().optional(),
});

export const moxxyConfigSchema = z.object({
  provider: providerSettingsSchema.optional(),
  mode: z.string().optional(),
  compactor: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  hookTimeoutMs: z.number().int().positive().optional(),
  watcher: watcherModeSchema.optional(),
  skills: z
    .object({
      projectDir: z.string().optional(),
      userDir: z.string().optional(),
      extraDirs: z.array(z.string()).optional(),
    })
    .optional(),
  embeddings: embeddingsConfigSchema.optional(),
  security: securityConfigSchema.optional(),
  plugins: z.record(z.string(), pluginSettingsSchema).optional(),
  channels: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  permissions: permissionsConfigSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type MoxxyConfig = z.infer<typeof moxxyConfigSchema>;
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type WatcherMode = z.infer<typeof watcherModeSchema>;
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;
export type SecurityConfig = z.infer<typeof securityConfigSchema>;
