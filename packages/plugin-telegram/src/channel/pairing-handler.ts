import type { Bot, Context } from 'grammy';
import type { VaultStore } from '@moxxy/plugin-vault';
import {
  beginPairing,
  clearPairing,
  createPairingState,
  handleStart,
  isAuthorized,
  submitTerminalCode,
  type PairingDecision,
  type PairingState,
} from '../pairing.js';

const AUTHORIZED_CHAT_KEY = 'telegram_authorized_chat_id';

/** Fires when /start lands in `pair` mode and a code is DM'd to the chat. */
export interface PairingIssuedEvent {
  readonly code: string;
  readonly chatId: number;
}

/** Result returned by `confirmPairingCode`. */
export type PairingConfirmResult =
  | { ok: true; chatId: number }
  | { ok: false; reason: 'mismatch' | 'expired' | 'not-pending' | 'no-window'; message: string };

export interface PairingHandlerOptions {
  readonly vault: VaultStore;
  readonly logger?: {
    info?(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Owns the pairing state machine + the bot-side `/start` handler + the
 * terminal-side `confirmPairingCode` flow. Keeps the bot reference
 * (re-)settable so the TelegramChannel can wire it up after construction.
 */
export class PairingHandler {
  private state: PairingState = createPairingState();
  private bot: Bot | null = null;
  private readonly opts: PairingHandlerOptions;
  private readonly issuedListeners = new Set<(e: PairingIssuedEvent) => void>();

  constructor(opts: PairingHandlerOptions) {
    this.opts = opts;
  }

  attachBot(bot: Bot | null): void {
    this.bot = bot;
  }

  async loadAuthorized(): Promise<void> {
    const authorizedRaw = await this.opts.vault.get(AUTHORIZED_CHAT_KEY);
    this.state = createPairingState({
      authorizedChatId: authorizedRaw ? Number(authorizedRaw) : null,
    });
  }

  isAuthorized(chatId: number): boolean {
    return isAuthorized(this.state, chatId);
  }

  phase(): PairingState['phase'] {
    return this.state.phase;
  }

  /**
   * Begin a pairing window. The terminal calls this before /start lands
   * in Telegram. No code is generated yet — `handleStart` issues the
   * code once /start arrives, so it can be DM'd to the specific chat
   * that asked for it.
   */
  beginWindow(): void {
    this.state = beginPairing(this.state);
  }

  unpair(): void {
    this.state = clearPairing(this.state);
  }

  /**
   * Subscribe to "code issued" events. Fires each time /start lands in
   * the pair window (including re-issues to the same chat). The wizard
   * subscribes before `start()` so the first /start can't race past it.
   * Returns an unsubscribe function.
   */
  onIssued(listener: (e: PairingIssuedEvent) => void): () => void {
    this.issuedListeners.add(listener);
    return () => this.issuedListeners.delete(listener);
  }

  /**
   * Called by the terminal wizard when the user pastes a code. Returns a
   * structured result the wizard can branch on (success / mismatch /
   * expired / not-pending). On success the chat-id is persisted to the
   * vault by this method directly; callers don't need to remember to
   * write it.
   */
  async confirmCode(rawInput: string): Promise<PairingConfirmResult> {
    if (this.state.phase === 'idle') {
      return { ok: false, reason: 'no-window', message: 'No pairing window is open.' };
    }
    const decision = submitTerminalCode(this.state, rawInput);
    this.state = decision.state;
    const action = decision.action;
    if (action.kind === 'paired') {
      await this.opts.vault.set(AUTHORIZED_CHAT_KEY, String(action.chatId));
      // Greet the chat that just got authorized so the user has a
      // confirmation on the Telegram side too — symmetric with the
      // success message they'll see in the terminal.
      if (this.bot) {
        try {
          await this.bot.api.sendMessage(
            action.chatId,
            '✅ Paired with the moxxy terminal. Send a prompt to begin.',
          );
        } catch (err) {
          this.opts.logger?.warn('pairing: greeting send failed', { err: String(err) });
        }
      }
      return { ok: true, chatId: action.chatId };
    }
    if (action.kind === 'still-paired') return { ok: true, chatId: action.chatId };
    if (action.kind === 'mismatch') return { ok: false, reason: 'mismatch', message: action.message };
    if (action.kind === 'expired') return { ok: false, reason: 'expired', message: action.message };
    if (action.kind === 'not-pending') return { ok: false, reason: 'not-pending', message: action.message };
    return { ok: false, reason: 'mismatch', message: 'unexpected pairing state' };
  }

  /** Bot-side /start handler — issues a code (or greets) based on phase. */
  async handleStartCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const decision: PairingDecision = handleStart(this.state, chatId);
    this.state = decision.state;
    const action = decision.action;
    if (action.kind === 'still-paired') {
      await ctx.reply('Welcome back! Send me a prompt.');
      return;
    }
    if (action.kind === 'issue-code') {
      // DM the code to the user, then notify the terminal wizard so it
      // can prompt for the code in the host.
      const body =
        `${action.message}\n\n` +
        `<b><code>${action.code}</code></b>\n\n` +
        `<i>Open your moxxy terminal and paste these 6 digits when prompted.</i>`;
      try {
        await ctx.reply(body, { parse_mode: 'HTML' });
      } catch (err) {
        this.opts.logger?.warn('telegram pair: failed to send code', { err: String(err) });
      }
      for (const listener of this.issuedListeners) {
        try {
          listener({ code: action.code, chatId: action.chatId });
        } catch (err) {
          this.opts.logger?.warn('pairing listener threw', { err: String(err) });
        }
      }
      return;
    }
    if (action.kind === 'reject' || action.kind === 'wait' || action.kind === 'expired') {
      await ctx.reply(action.message);
    }
  }
}
