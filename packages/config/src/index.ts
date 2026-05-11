export { defineConfig } from './define.js';
export { loadConfig, type LoadConfigOptions, type LoadedConfig } from './loader.js';
export { mergeConfigs } from './merge.js';
export {
  moxxyConfigSchema,
  pluginSettingsSchema,
  providerSettingsSchema,
  permissionsConfigSchema,
  watcherModeSchema,
  type MoxxyConfig,
  type PluginSettings,
  type ProviderSettings,
  type PermissionsConfig,
  type WatcherMode,
} from './schema.js';
