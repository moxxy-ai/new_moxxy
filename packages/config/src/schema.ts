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
  loop: z.string().optional(),
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
