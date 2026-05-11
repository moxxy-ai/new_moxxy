import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { anthropicModels } from '@moxxy/plugin-provider-anthropic';
import { openAIModels } from '@moxxy/plugin-provider-openai';
import { setupSessionWithConfig } from '../setup.js';
import { PROVIDER_KEYS } from '../provider-keys.js';
import type { ParsedArgv } from '../argv.js';

/**
 * Interactive first-time setup. Mounts the Ink-based SetupWizard, which walks
 * the user through provider selection, API-key entry, model + loop + embedder
 * picks, and emits a moxxy.config.yaml.
 *
 * If stdin isn't a TTY, falls back to a minimal headless flow that just
 * forwards env vars into the vault.
 */
export async function runInitCommand(_argv: ParsedArgv): Promise<number> {
  // Boot the session up front so the vault is unlocked once (keychain or
  // passphrase) before we start prompting for keys.
  const { vault } = await setupSessionWithConfig({
    cwd: process.cwd(),
    skipKeyPrompt: true,
  });

  if (!process.stdin.isTTY) {
    return await runHeadlessInit(vault);
  }

  const [React, { render }, plugin] = await Promise.all([
    import('react'),
    import('ink'),
    import('@moxxy/plugin-cli'),
  ]);
  const { SetupWizard } = plugin;

  const providers = [
    { id: 'anthropic', label: 'Anthropic', description: 'Claude — Sonnet / Opus / Haiku' },
    { id: 'openai', label: 'OpenAI', description: 'GPT-4o / 4o-mini / 4-turbo' },
  ];

  const models = {
    anthropic: anthropicModels.map((m) => ({ id: m.id, label: m.id })),
    openai: openAIModels.map((m) => ({ id: m.id, label: m.id })),
  };

  const loops = [
    { id: 'tool-use', label: 'tool-use', description: 'Default Claude Code-style loop (recommended)' },
    { id: 'plan-execute', label: 'plan-execute', description: 'Plan-then-execute strategy' },
  ];

  const embedders = [
    { id: 'tfidf', label: 'TF-IDF', description: 'Built-in, zero deps, no API key (recommended)' },
    { id: 'openai', label: 'OpenAI', description: 'text-embedding-3-small (1536d) via OpenAI API' },
    { id: 'transformers', label: 'Local (transformers.js)', description: 'all-MiniLM-L6-v2, no API key, ~80MB download' },
    { id: 'none', label: 'None', description: 'Keyword recall only' },
  ];

  const target = path.join(process.cwd(), 'moxxy.config.yaml');

  const controller = {
    async saveApiKey(providerId: string, key: string): Promise<void> {
      const canonical = PROVIDER_KEYS[providerId];
      if (!canonical) throw new Error(`unknown provider: ${providerId}`);
      await vault.set(canonical, key, [providerId]);
    },
    async writeConfig(yaml: string): Promise<string> {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, yaml);
      return target;
    },
  };

  await new Promise<void>((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(SetupWizard, {
        providers,
        models,
        loops,
        embedders,
        controller,
      }),
    );
    void waitUntilExit().then(() => resolve());
  });

  return 0;
}

async function runHeadlessInit(vault: import('@moxxy/plugin-vault').VaultStore): Promise<number> {
  process.stderr.write('moxxy init: no TTY — running headless. Reading provider keys from env.\n');
  let saved = 0;
  for (const [provider, canonical] of Object.entries(PROVIDER_KEYS)) {
    const value = process.env[canonical];
    if (!value) continue;
    try {
      const existing = await vault.get(canonical);
      if (existing) continue;
      await vault.set(canonical, value, [provider]);
      saved += 1;
    } catch {
      // skip
    }
  }
  process.stderr.write(`moxxy init: saved ${saved} key(s) to vault.\n`);
  return 0;
}
