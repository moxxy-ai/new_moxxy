import type { MoxxyConfig } from './schema.js';

/**
 * Typed configuration factory. Use in `moxxy.config.ts`:
 *
 *   import { defineConfig } from '@moxxy/config';
 *
 *   export default defineConfig({
 *     provider: { name: 'anthropic', model: 'claude-sonnet-4-6' },
 *     plugins: {
 *       '@moxxy/plugin-mcp': { enabled: true, options: { servers: [...] } },
 *       '@acme/moxxy-plugin-shell': { enabled: false },
 *     },
 *     watcher: 'auto',
 *   });
 */
export function defineConfig(config: MoxxyConfig): MoxxyConfig {
  return config;
}
