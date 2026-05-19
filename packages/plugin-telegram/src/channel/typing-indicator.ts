import type { Bot } from 'grammy';

/**
 * Show a "typing…" indicator in the chat for the lifetime of a turn.
 * Telegram clears the indicator ~5s after the last sendChatAction, so
 * we re-fire every 4s. Best-effort — a single failure shouldn't crash
 * the turn (we keep the interval going so transient network blips
 * recover on the next tick).
 */
export class TypingIndicator {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(bot: Bot | null, chatId: number): void {
    if (!bot) return;
    this.stop();
    const fire = (): void => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {
        /* best-effort */
      });
    };
    fire();
    this.timer = setInterval(fire, 4_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
