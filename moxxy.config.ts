import { defineConfig } from '@moxxy/config';

/**
 * Reference moxxy.config.ts for this monorepo. Demonstrates the
 * shape consumers will use to override auto-discovery, pick a default
 * loop strategy and model, configure skill search paths, etc.
 *
 * Note: this file is not auto-loaded by tests (each package's tests
 * sandbox their own cwd). It is read by the `moxxy` CLI when invoked
 * from anywhere in this repo.
 */
export default defineConfig({
  provider: {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  loop: 'tool-use',
  compactor: 'summarize-old-turns',
  watcher: 'manual',
  hookTimeoutMs: 5000,
});
