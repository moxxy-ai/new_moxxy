export { defineConfig } from './define.js';
export { loadConfig, type LoadConfigOptions, type LoadedConfig } from './loader.js';
export { mergeConfigs } from './merge.js';
export {
  moxxyConfigSchema,
  pluginSettingsSchema,
  providerSettingsSchema,
  permissionsConfigSchema,
  embeddingsConfigSchema,
  watcherModeSchema,
  type MoxxyConfig,
  type PluginSettings,
  type ProviderSettings,
  type PermissionsConfig,
  type EmbeddingsConfig,
  type WatcherMode,
} from './schema.js';
