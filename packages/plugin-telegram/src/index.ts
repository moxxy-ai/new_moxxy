import { defineChannel, defineTool, definePlugin, z, type Plugin } from '@moxxy/sdk';
import type { VaultStore } from '@moxxy/plugin-vault';
import { Bot } from 'grammy';
import { TelegramChannel } from './channel.js';
import { TELEGRAM_AUTHORIZED_CHAT_KEY, TELEGRAM_TOKEN_KEY } from './keys.js';
import { runTelegramWizard } from './setup-wizard.js';
import { runPairFlow } from './pair-flow.js';

export {
  TelegramChannel,
  type TelegramChannelOptions,
  type TelegramStartOpts,
} from './channel.js';
export { TelegramPermissionResolver, type PendingPermission } from './permission.js';
export { TelegramApprovalResolver, type PendingApproval } from './approval.js';
export {
  createPairingState,
  beginPairing,
  handleStart,
  submitTerminalCode,
  isAuthorized,
  clearPairing,
  type PairingPhase,
  type PairingState,
  type PairingDecision,
} from './pairing.js';
export type { PairingIssuedEvent, PairingConfirmResult } from './channel.js';
export { TurnRenderer, splitForTelegram } from './render.js';
export { markdownToTelegramHtml } from './format.js';

export interface BuildTelegramPluginOptions {
  readonly vault: VaultStore;
}

export { TELEGRAM_TOKEN_KEY, TELEGRAM_AUTHORIZED_CHAT_KEY, TELEGRAM_TOKEN_RE } from './keys.js';

// Backwards-compat aliases for the existing call sites in this file.
const TOKEN_KEY = TELEGRAM_TOKEN_KEY;
const AUTHORIZED_CHAT_KEY = TELEGRAM_AUTHORIZED_CHAT_KEY;

export function buildTelegramPlugin(opts: BuildTelegramPluginOptions): Plugin {
  return definePlugin({
    name: '@moxxy/plugin-telegram',
    version: '0.0.0',
    channels: [
      defineChannel({
        name: 'telegram',
        description: 'Telegram bot channel via grammy. TOFU + code-pairing authorization.',
        create: (deps) =>
          new TelegramChannel({
            vault: opts.vault,
            token: (deps.options?.['token'] as string | undefined) ?? undefined,
            logger: deps.logger as never,
          }),
        isAvailable: async () => {
          const envToken = process.env.MOXXY_TELEGRAM_TOKEN;
          if (envToken) return { ok: true };
          try {
            const stored = await opts.vault.has(TOKEN_KEY);
            if (stored) return { ok: true };
            return {
              ok: false,
              reason:
                "No bot token. Set MOXXY_TELEGRAM_TOKEN, or store one in the vault as '" +
                TOKEN_KEY +
                "' via the `telegram-setup` skill.",
            };
          } catch {
            return {
              ok: false,
              reason:
                'Set MOXXY_TELEGRAM_TOKEN to skip the vault, or unlock the vault first.',
            };
          }
        },
        interactiveCommand: 'setup',
        subcommands: {
          setup: {
            description:
              'Interactive setup: store a bot token, pair a chat, then start the bot. Shown by default for `moxxy telegram` on a TTY.',
            run: async (ctx) => {
              // The wizard drives token entry + pairing through clack
              // prompts, so it needs an interactive terminal. In a
              // headless invocation we just start the bot directly.
              if (process.stdin.isTTY !== true) {
                return ctx.startChannel();
              }
              return runTelegramWizard(ctx);
            },
          },
          pair: {
            description:
              'Open a pairing window. Send /start to your bot in Telegram; it will DM a 6-digit code to paste back in the terminal.',
            run: async (ctx) => {
              // Pairing requires an interactive terminal - the user
              // must paste the bot-issued code into a prompt. In a
              // headless invocation we bail with a clear message
              // instead of silently starting a bot that nobody can
              // confirm.
              if (process.stdin.isTTY !== true) {
                process.stderr.write(
                  'Pairing needs a TTY. Run `moxxy telegram` (interactively) on a workstation, then copy the resulting vault to this host.\n',
                );
                return 1;
              }
              return runPairFlow(ctx);
            },
          },
          unpair: {
            description: 'Forget the currently authorized Telegram chat.',
            run: async (ctx) => {
              const vault = ctx.deps.vault as VaultStore | undefined;
              if (!vault) {
                process.stderr.write('vault unavailable\n');
                return 1;
              }
              const removed = await vault.delete(AUTHORIZED_CHAT_KEY);
              process.stdout.write(removed ? 'unpaired\n' : 'no pairing was active\n');
              return 0;
            },
          },
          status: {
            description: 'Report whether a Telegram token + an authorized chat are configured.',
            run: async (ctx) => {
              const vault = ctx.deps.vault as VaultStore | undefined;
              if (!vault) {
                process.stderr.write('vault unavailable\n');
                return 1;
              }
              const hasToken = await vault.has(TOKEN_KEY);
              const authorized = await vault.get(AUTHORIZED_CHAT_KEY);
              process.stdout.write(
                JSON.stringify(
                  {
                    tokenConfigured: hasToken,
                    authorizedChatId: authorized ? Number(authorized) : null,
                  },
                  null,
                  2,
                ) + '\n',
              );
              return 0;
            },
          },
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'telegram_set_token',
        description:
          'Store a Telegram bot token (from @BotFather) in the vault under telegram_bot_token. Validates the token shape but does not test connectivity.',
        inputSchema: z.object({
          token: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'token must look like 1234567890:ABC...'),
        }),
        permission: { action: 'prompt' },
        handler: async ({ token }) => {
          await opts.vault.set(TOKEN_KEY, token, ['telegram']);
          return `stored Telegram token (${token.split(':')[0]}:…) in vault`;
        },
      }),
      defineTool({
        name: 'telegram_status',
        description: 'Report whether a Telegram token + an authorized chat are configured.',
        inputSchema: z.object({}),
        handler: async () => {
          const hasToken = await opts.vault.has(TOKEN_KEY);
          const authorized = await opts.vault.get(AUTHORIZED_CHAT_KEY);
          return {
            tokenConfigured: hasToken,
            authorizedChatId: authorized ? Number(authorized) : null,
          };
        },
      }),
      defineTool({
        name: 'telegram_send_message',
        description:
          'Push a one-off message to the currently authorized Telegram chat. Use this from a ' +
          "scheduled prompt to deliver results without an interactive channel running. The " +
          'message is sent via the Bot API directly — no streaming, no formatting. Requires ' +
          'a stored bot token + a paired chat (run `moxxy channels telegram pair` once).',
        inputSchema: z.object({
          text: z.string().min(1).max(4096),
          /** Optional override; defaults to the vault-paired chat id. */
          chatId: z.number().int().optional(),
          parseMode: z.enum(['MarkdownV2', 'Markdown', 'HTML']).optional(),
        }),
        permission: { action: 'prompt' },
        handler: async ({ text, chatId, parseMode }) => {
          const token = process.env.MOXXY_TELEGRAM_TOKEN ?? (await opts.vault.get(TOKEN_KEY));
          if (!token) {
            throw new Error(
              'no Telegram bot token configured (set MOXXY_TELEGRAM_TOKEN or run `moxxy init` to store one)',
            );
          }
          const targetChat =
            chatId ??
            (await opts.vault.get(AUTHORIZED_CHAT_KEY).then((v) => (v ? Number(v) : null)));
          if (!targetChat) {
            throw new Error(
              'no authorized chat — run `moxxy channels telegram pair` first or pass `chatId` explicitly',
            );
          }
          const bot = new Bot(token);
          await bot.api.sendMessage(targetChat, text, parseMode ? { parse_mode: parseMode } : {});
          return { delivered: true, chatId: targetChat, length: text.length };
        },
      }),
      defineTool({
        name: 'telegram_unpair',
        description: 'Forget the currently authorized Telegram chat. The next /start will start a fresh pairing.',
        inputSchema: z.object({}),
        permission: { action: 'prompt' },
        handler: async () => {
          const removed = await opts.vault.delete(AUTHORIZED_CHAT_KEY);
          return removed ? 'unpaired' : 'no pairing was active';
        },
      }),
    ],
  });
}
