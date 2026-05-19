import { Bot, GrammyError } from 'grammy';
import { TurnRenderer, splitForTelegram } from '../render.js';
import { composeFrame, stripHtml } from './html.js';

export interface FramePumpLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface FramePumpOptions {
  readonly editFrameMs: number;
  readonly logger?: FramePumpLogger;
}

/**
 * Drives the throttled "compose snapshot → send/edit one message" loop
 * for a turn. Owns the edit timer and the running messageId so the
 * channel can stay focused on dispatch.
 *
 * Lifecycle per turn:
 *   1. `beginTurn(chatId)` resets state.
 *   2. Renderer updates schedule edits via `scheduleEdit()`.
 *   3. `flush(final)` drains the latest snapshot to Telegram.
 *   4. `endTurn()` clears timers + chat binding.
 */
export class FramePump {
  private readonly editFrameMs: number;
  private readonly logger?: FramePumpLogger;
  private bot: Bot | null = null;
  private renderer: TurnRenderer = new TurnRenderer();
  private chatId: number | null = null;
  private messageId: number | null = null;
  private lastSentFrame = '';
  private editTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: FramePumpOptions) {
    this.editFrameMs = opts.editFrameMs;
    if (opts.logger) this.logger = opts.logger;
  }

  attachBot(bot: Bot | null): void {
    this.bot = bot;
  }

  /** Renderer the channel feeds events into. Owned here so reset/snapshot
   *  cycles stay coordinated with the message-id state. */
  get renderState(): TurnRenderer {
    return this.renderer;
  }

  resetRenderer(): void {
    this.renderer.reset();
  }

  beginTurn(chatId: number): void {
    this.renderer.reset();
    this.chatId = chatId;
    this.messageId = null;
    this.lastSentFrame = '';
  }

  endTurn(): void {
    this.cancelTimer();
    this.chatId = null;
    this.messageId = null;
  }

  scheduleEdit(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.flush(false);
    }, this.editFrameMs);
  }

  async flush(final: boolean): Promise<void> {
    this.cancelTimer();
    if (!this.bot || !this.chatId) return;
    const snap = this.renderer.snapshot();
    const html = composeFrame(snap);
    if (!html || html === this.lastSentFrame) {
      // Nothing rendered yet AND it's the final flush — must produce
      // at least one message so the user isn't left with the typing
      // indicator dangling.
      if (final && !html && this.messageId == null) {
        await this.safeSend(this.chatId, '<i>(no output)</i>');
      }
      return;
    }
    const parts = splitForTelegram(html);
    const head = parts[0]!;
    if (this.messageId == null) {
      // First real content of this turn — send (don't edit a placeholder).
      const sent = await this.safeSend(this.chatId, head);
      if (sent) this.messageId = sent;
    } else {
      await this.safeEdit(this.chatId, this.messageId, head);
    }
    this.lastSentFrame = head;
    if (final && parts.length > 1) {
      for (const tail of parts.slice(1)) {
        await this.safeSend(this.chatId, tail);
      }
    }
  }

  /**
   * `text` is already Telegram-flavored HTML (produced by
   * `composeFrame`). Try HTML; on parse-entity errors, strip tags and
   * send plain text so the message still lands instead of looping on
   * the same edit forever.
   */
  async safeEdit(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.bot!.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return;
    } catch (err) {
      if (err instanceof GrammyError && err.description?.includes('not modified')) return;
      if (err instanceof GrammyError && /can't parse entities|Bad Request: can't parse/i.test(err.description ?? '')) {
        try {
          await this.bot!.api.editMessageText(chatId, messageId, stripHtml(text));
          return;
        } catch (plainErr) {
          if (plainErr instanceof GrammyError && plainErr.description?.includes('not modified')) return;
          this.logger?.warn('editMessageText plain-fallback failed', { err: String(plainErr) });
          return;
        }
      }
      this.logger?.warn('editMessageText failed', { err: String(err) });
    }
  }

  /**
   * Send a new message (first frame of a turn or split-tail).
   * Returns the new message_id on success so callers can set
   * messageId for future edits.
   */
  async safeSend(chatId: number, text: string): Promise<number | null> {
    try {
      const sent = await this.bot!.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return sent.message_id;
    } catch (err) {
      if (err instanceof GrammyError && /can't parse entities|Bad Request: can't parse/i.test(err.description ?? '')) {
        try {
          const sent = await this.bot!.api.sendMessage(chatId, stripHtml(text));
          return sent.message_id;
        } catch (plainErr) {
          this.logger?.warn('sendMessage plain-fallback failed', { err: String(plainErr) });
          return null;
        }
      }
      this.logger?.warn('sendMessage failed', { err: String(err) });
      return null;
    }
  }

  private cancelTimer(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }
}
