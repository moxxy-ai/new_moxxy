import * as path from 'node:path';
import * as os from 'node:os';
import {
  z,
  defineTool,
  definePlugin,
  type Plugin,
  type CommandDef,
  type EmittedEvent,
  type TurnId,
} from '@moxxy/sdk';
import { createCombinedKeySource, type MasterKeySource } from './keysource.js';
import { VaultStore } from './store.js';

export { VaultStore, VaultPassphraseError } from './store.js';
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

  // `/vault` slash command. Lets the USER store a secret out-of-band: the
  // value travels in the slash-command args, which channels intercept and
  // never send to the model. After storing, we inject a note into the event
  // log telling the model only the REFERENCE (`${vault:NAME}`) — never the
  // plaintext — so the model can wire it up (config/tools) without seeing it.
  const vaultCmd: CommandDef = {
    name: 'vault',
    description: 'Store a secret or list stored names',
    pendingNotice: 'updating vault',
    handler: async (ctx) => {
      const trimmed = ctx.args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);

      if (!sub || sub === 'help') {
        return { kind: 'text', text: vaultCommandUsage() };
      }

      if (sub === 'list') {
        const entries = await vault.list();
        if (entries.length === 0) {
          return { kind: 'text', text: 'Vault is empty. Store a secret with `/vault set <name> <value>`.' };
        }
        const lines = entries.map(
          (e) => `  ${e.name}${e.tags && e.tags.length ? `  [${e.tags.join(', ')}]` : ''}  →  \${vault:${e.name}}`,
        );
        return { kind: 'text', text: `Stored secrets (values hidden):\n${lines.join('\n')}` };
      }

      if (sub === 'set') {
        const name = rest[0];
        const value = rest.slice(1).join(' ');
        if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
          return {
            kind: 'error',
            message: 'usage: /vault set <name> <value>  (name may contain letters, digits, _ . -)',
          };
        }
        if (!value) {
          return { kind: 'error', message: `usage: /vault set ${name} <value>  — a value is required` };
        }

        await vault.set(name, value);

        // Inform the model with a reference only — never the plaintext. Keep it
        // terse: the behavioral guidance ("never ask for plaintext") lives in
        // the vault-setup skill. The note projects as a message on the next turn
        // and renders as a dim system note in the TUI (see EventLine).
        const note =
          `[vault] Secret "${name}" stored. Reference it as \${vault:${name}} — its value is hidden from you.`;
        try {
          const s = ctx.session as VaultCommandSession;
          await s.log.append({
            type: 'user_prompt',
            sessionId: ctx.sessionId,
            turnId: s.startTurn().turnId,
            source: 'system',
            text: note,
          });
        } catch {
          // If the host session doesn't expose log/startTurn (unexpected),
          // still confirm storage to the user below.
        }

        return {
          kind: 'text',
          text:
            `✓ Stored "${name}" securely in the vault. ` +
            `The assistant can reference it as \${vault:${name}} without ever seeing the value.`,
        };
      }

      return { kind: 'error', message: `unknown subcommand "${sub}".\n${vaultCommandUsage()}` };
    },
  };

  const plugin = definePlugin({
    name: '@moxxy/plugin-vault',
    version: '0.0.0',
    commands: [vaultCmd],
    tools: [
      defineTool({
        name: 'vault_set',
        description:
          'Store a secret in the encrypted vault. Overwrites if name exists. ' +
          'IMPORTANT: do NOT use this for a secret the USER supplies — that would route the ' +
          'plaintext through the conversation. Instead tell the user to run `/vault set <name> <value>` ' +
          'themselves; you only receive a ${vault:<name>} reference. Use this tool only for a value you ' +
          'legitimately already hold and may see.',
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

/**
 * Minimal slice of the real Session the /vault command needs to inject its
 * reference note. Loosely typed so the package stays free of a core dep —
 * the plugin host passes a real Session that satisfies this.
 */
interface VaultCommandSession {
  startTurn(): { turnId: TurnId };
  log: { append(event: EmittedEvent): Promise<unknown> };
}

function vaultCommandUsage(): string {
  return (
    'usage:\n' +
    '  /vault set <name> <value>   store a secret (the value is hidden from the assistant)\n' +
    '  /vault list                 list stored secret names'
  );
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
