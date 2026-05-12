import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { bootSessionWithConfig } from '../argv-helpers.js';
import { canonicalKey } from '../provider-keys.js';
import { validateProviderKey } from '../validate-key.js';
import type { ParsedArgv } from '../argv.js';

/**
 * Interactive first-time setup. Mounts the Ink-based SetupWizard, which walks
 * the user through provider selection, API-key entry, model + loop + embedder
 * picks, and emits a moxxy.config.yaml.
 *
 * Everything provider-specific is driven by the session's ProviderRegistry —
 * the CLI itself doesn't know about Anthropic or OpenAI by name. New providers
 * appear in the wizard automatically as long as their plugin is loaded.
 *
 * If stdin isn't a TTY, falls back to a minimal headless flow that just
 * forwards env vars into the vault.
 */
export async function runInitCommand(argv: ParsedArgv): Promise<number> {
  // `skipProviderActivation` is critical here: without it, the activation
  // loop calls `vault.get()` for every candidate provider, which opens the
  // vault, which on a first-time-no-keytar install triggers an invisible
  // readline passphrase prompt that hangs the wizard. The init flow is
  // *itself* what populates the vault — running activation pre-mount is
  // both pointless and a UX trap.
  const { session, vault } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    skipProviderActivation: true,
  });

  if (!process.stdin.isTTY) {
    return await runHeadlessInit(session, vault);
  }

  // Pre-warm the vault BEFORE we mount Ink. A first-time install (no
  // keytar entry yet) needs to prompt for a passphrase; that prompt uses
  // stdin/readline and would deadlock against Ink if it fired while the
  // wizard was rendering. Open it here while the terminal is still raw,
  // then Ink takes over with an unlocked vault and vault.set() is silent.
  await vault.open();

  const [React, { render }, plugin] = await Promise.all([
    import('react'),
    import('ink'),
    import('@moxxy/plugin-cli'),
  ]);
  const { SetupWizard } = plugin;

  const providerDefs = session.providers.list();
  const providers = providerDefs.map((p) => ({
    id: p.name,
    label: titleCase(p.name),
    description: p.models[0]?.id ? `default model: ${p.models[0].id}` : undefined,
  }));
  const models = Object.fromEntries(
    providerDefs.map((p) => [p.name, p.models.map((m) => ({ id: m.id, label: m.id }))]),
  );

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
      await vault.set(canonicalKey(providerId), key, [providerId]);
    },
    async writeConfig(yaml: string): Promise<string> {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, yaml);
      return target;
    },
    async testKey(
      providerId: string,
      key: string,
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      return await validateProviderKey(providerId, key, session.providers);
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

async function runHeadlessInit(
  session: import('@moxxy/core').Session,
  vault: import('@moxxy/plugin-vault').VaultStore,
): Promise<number> {
  process.stderr.write('moxxy init: no TTY — running headless. Reading provider keys from env.\n');
  let saved = 0;
  for (const provider of session.providers.list()) {
    const canonical = canonicalKey(provider.name);
    const value = process.env[canonical];
    if (!value) continue;
    try {
      const existing = await vault.get(canonical);
      if (existing) continue;
      await vault.set(canonical, value, [provider.name]);
      saved += 1;
    } catch {
      // skip
    }
  }
  process.stderr.write(`moxxy init: saved ${saved} key(s) to vault.\n`);
  return 0;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
