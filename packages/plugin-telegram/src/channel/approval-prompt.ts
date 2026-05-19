import { type Bot, InlineKeyboard } from 'grammy';
import type { ApprovalRequest } from '@moxxy/sdk';
import type { TelegramApprovalResolver } from '../approval.js';
import { truncate } from './html.js';

export interface ApprovalPromptDeps {
  readonly bot: Bot | null;
  readonly chatId: number | null;
  readonly resolver: TelegramApprovalResolver;
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Render an approval request (e.g. plan-execute "validate plan") as a
 * message + inline-keyboard option list. Options with `requestsText`
 * are still picked here; the callback handler then captures the user's
 * NEXT message as the follow-up text via the channel's awaiting-text
 * state.
 */
export async function askForApproval(
  id: string,
  request: ApprovalRequest,
  deps: ApprovalPromptDeps,
): Promise<void> {
  if (!deps.bot || !deps.chatId) return;
  const keyboard = new InlineKeyboard();
  for (const opt of request.options) {
    const label = `${opt.hotkey ? `[${opt.hotkey}] ` : ''}${opt.label}`;
    keyboard.text(label, `appr:${id}:${opt.id}`).row();
  }
  // Telegram has a ~4096-char message limit; truncate the body so a
  // verbose plan doesn't fail to send. The full plan is also in the
  // chat scrollback (the assistant_message events get streamed in).
  const bodySnippet = truncate(request.body, 3000);
  const summary =
    `📋 ${request.title}\n\n${bodySnippet}\n\n` +
    `Pick an option below. Some options (e.g. Redraft) will prompt for follow-up text after you click.`;
  try {
    await deps.bot.api.sendMessage(deps.chatId, summary, { reply_markup: keyboard });
  } catch (err) {
    deps.logger?.warn('approval send failed', { err: String(err) });
    // Default-resolve on send failure so the loop strategy doesn't hang.
    const fallback = request.defaultOptionId ?? request.options[0]?.id ?? 'cancel';
    deps.resolver.resolvePending(id, fallback);
  }
}
