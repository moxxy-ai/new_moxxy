import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { bootSessionWithConfig } from '../argv-helpers.js';
import { canonicalKey } from '../provider-keys.js';
import { validateProviderKey } from '../validate-key.js';
import type { ParsedArgv } from '../argv.js';
import { cliVersion } from '../version.js';
import { runSetupWizard } from '../wizard/run-setup-wizard.js';
import { buildProviderAuthContext } from '../wizard/auth-context.js';
import { renderLogo } from '../logo.js';
import type { ProviderAuthKind } from '@moxxy/plugin-cli';
import { MoxxyError, type ProviderDef } from '@moxxy/sdk';

/**
 * Interactive first-time setup. Renders a @clack/prompts vertical stepper
 * that walks the user through provider selection, credential entry, model +
 * loop + embedder picks, and emits a moxxy.config.yaml.
 *
 * The wizard is fully provider-agnostic — it reads each registered
 * provider's `ProviderDef.auth` descriptor to decide whether to prompt for
 * an API key or to drive that provider's OAuth flow. Installing a new
 * provider plugin (current or future `moxxy provider install <pkg>`) is
 * enough to make it appear here; no CLI-side branch table.
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

  // Pre-warm the vault BEFORE starting the wizard. A first-time install
  // (no keytar entry yet) needs to prompt for a passphrase via readline;
  // doing that mid-clack would garble the rendering. Opening here while
  // the terminal is in cooked mode keeps the prompt clean.
  await vault.open();

  // Banner above the wizard intro. The clack `intro()` line will land
  // immediately under this with a `┌` corner, giving the impression that
  // the whole flow flows out of the moxxy logo.
  process.stdout.write(renderLogo());

  const providerDefs = session.providers.list();
  const defsByName = new Map(providerDefs.map((d) => [d.name, d] as const));

  const providers = providerDefs.map((p) => {
    const description = providerDescription(p);
    return description === undefined
      ? { id: p.name, label: titleCase(p.name) }
      : { id: p.name, label: titleCase(p.name), description };
  });
  const models = Object.fromEntries(
    providerDefs.map((p) => [p.name, p.models.map((m) => ({ id: m.id, label: m.id }))]),
  );
  const authKinds: Record<string, ProviderAuthKind> = Object.fromEntries(
    providerDefs.map((p) => [p.name, providerAuthKind(p)]),
  );

  const modes = [
    { id: 'tool-use', label: 'tool-use', description: 'Default Claude Code-style mode (recommended)' },
    { id: 'plan-execute', label: 'plan-execute', description: 'Plan-then-execute strategy' },
    {
      id: 'bmad',
      label: 'bmad',
      description: 'BMAD: Analysis → Planning → Solutioning → Implementation (multi-persona)',
    },
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
    async loginOAuth(providerId: string): Promise<void> {
      const def = defsByName.get(providerId);
      if (!def || def.auth?.kind !== 'oauth') {
        throw new MoxxyError({
          code: 'OAUTH_FLOW_NOT_SUPPORTED',
          message: `Provider "${providerId}" does not advertise an OAuth flow.`,
          hint:
            'This provider expects an API key. Re-run `moxxy init` and provide the key when prompted, ' +
            'or set the relevant *_API_KEY environment variable.',
          context: { provider: providerId },
        });
      }
      // We already bailed to runHeadlessInit when stdin wasn't a TTY, so
      // the browser flow is the default here.
      const ctx = buildProviderAuthContext(vault, { headless: false });
      await def.auth.login(ctx);
    },
  };

  await runSetupWizard({
    providers,
    models,
    modes,
    embedders,
    controller,
    authKinds,
    ...(cliVersion() ? { version: cliVersion()! } : {}),
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
    if (providerAuthKind(provider) === 'oauth') {
      // OAuth providers can't auto-bootstrap from an env var; the device-code
      // flow needs a user. Skip silently — the user will run
      // `moxxy login <name>` separately.
      continue;
    }
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

function providerAuthKind(def: ProviderDef): ProviderAuthKind {
  return def.auth?.kind === 'oauth' ? 'oauth' : 'apiKey';
}

function providerDescription(def: ProviderDef): string | undefined {
  if (def.auth?.kind === 'oauth') {
    const service = def.auth.serviceName;
    return service ? `OAuth · ${service}` : 'OAuth sign-in';
  }
  return def.models[0]?.id ? `default model: ${def.models[0].id}` : undefined;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
