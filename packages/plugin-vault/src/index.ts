import * as path from 'node:path';
import * as os from 'node:os';
import { z, defineTool, definePlugin, type Plugin } from '@moxxy/sdk';
import { createCombinedKeySource, type MasterKeySource } from './keysource.js';
import { VaultStore } from './store.js';

export { VaultStore } from './store.js';
export type { VaultEntry, VaultEntryInfo, VaultStoreOptions } from './store.js';
export { createCombinedKeySource, createStaticKeySource, type MasterKeySource } from './keysource.js';
export { resolveString, resolveValue, containsPlaceholder } from './placeholder.js';
export { deriveKey, encrypt, decrypt, generateSalt, randomCode } from './crypto.js';

export interface BuildVaultPluginOptions {
  readonly filePath?: string;
  readonly keySource?: MasterKeySource;
  readonly passphrasePrompt?: () => Promise<string>;
  readonly envVar?: string;
  readonly disableKeytar?: boolean;
}

export function defaultVaultPath(): string {
  return path.join(os.homedir(), '.moxxy', 'vault.json');
}

export function buildVaultPlugin(opts: BuildVaultPluginOptions = {}): { plugin: Plugin; vault: VaultStore } {
  const filePath = opts.filePath ?? defaultVaultPath();
  const keySource =
    opts.keySource ??
    createCombinedKeySource({
      passphrasePrompt: opts.passphrasePrompt ?? defaultPrompt,
      envVar: opts.envVar,
      disableKeytar: opts.disableKeytar,
    });
  const vault = new VaultStore({ filePath, keySource });

  const plugin = definePlugin({
    name: '@moxxy/plugin-vault',
    version: '0.0.0',
    tools: [
      defineTool({
        name: 'vault_set',
        description: 'Store a secret in the encrypted vault. Overwrites if name exists.',
        inputSchema: z.object({
          name: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/),
          value: z.string().min(1),
          tags: z.array(z.string()).optional(),
        }),
        permission: { action: 'prompt' },
        handler: async ({ name, value, tags }) => {
          await vault.set(name, value, tags);
          return `stored ${name} (${value.length} chars) in vault`;
        },
      }),
      defineTool({
        name: 'vault_get',
        description: 'Fetch a secret from the encrypted vault by name. Returns the plaintext value.',
        inputSchema: z.object({ name: z.string().min(1) }),
        permission: { action: 'prompt' },
        handler: async ({ name }) => {
          const value = await vault.get(name);
          if (value === null) throw new Error(`vault: '${name}' not found`);
          return value;
        },
      }),
      defineTool({
        name: 'vault_list',
        description: 'List entries in the vault. Returns names + metadata only, never plaintext.',
        inputSchema: z.object({}),
        permission: { action: 'prompt' },
        handler: async () => {
          const entries = await vault.list();
          return entries.map((e) => ({ name: e.name, createdAt: e.createdAt, tags: e.tags ?? [] }));
        },
      }),
      defineTool({
        name: 'vault_delete',
        description: 'Delete a vault entry by name.',
        inputSchema: z.object({ name: z.string().min(1) }),
        permission: { action: 'prompt' },
        handler: async ({ name }) => {
          const removed = await vault.delete(name);
          return removed ? `deleted ${name}` : `not found: ${name}`;
        },
      }),
      defineTool({
        name: 'vault_status',
        description: 'Report which key source unlocked the vault (keychain, env, passphrase).',
        inputSchema: z.object({}),
        handler: async () => {
          await vault.open();
          const entries = await vault.list();
          return { source: vault.sourceName, entries: entries.length };
        },
      }),
    ],
  });

  return { plugin, vault };
}

async function defaultPrompt(): Promise<string> {
  // Headless default: refuse if no TTY. Interactive shells override this via opts.
  if (!process.stdin.isTTY) {
    throw new Error(
      'vault: passphrase required but no interactive terminal. Set MOXXY_VAULT_PASSPHRASE or pass a custom passphrasePrompt.',
    );
  }
  const readline = await import('node:readline/promises');
  // Write to stdout (not stderr) and include a leading newline + bold-ish
  // banner so users can't miss the prompt — the bare `vault passphrase: `
  // sent to stderr was easy to overlook (looked like a hang).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      '\n[1m[33mmoxxy vault[39m[22m needs a passphrase.\n' +
        'Pick one now (it\'s stored in your OS keychain if available).\n' +
        'Set [2mMOXXY_VAULT_PASSPHRASE[22m to skip this prompt.\n\n',
    );
    const answer = (await rl.question('passphrase: ')).trim();
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}
