import { type Bot, InlineKeyboard } from 'grammy';
import type { PendingToolCall, PermissionContext } from '@moxxy/sdk';
import type { Session } from '@moxxy/core';
import type { TelegramPermissionResolver } from '../permission.js';
import { truncate } from './html.js';

export interface PermissionPromptDeps {
  readonly bot: Bot | null;
  readonly chatId: number | null;
  readonly session: Session | null;
  readonly resolver: TelegramPermissionResolver;
  readonly yolo: boolean;
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Render an inline-keyboard permission prompt for a pending tool call.
 * The decider promise resolves when the user clicks a button (routed
 * back via the callback handler) or when the resolver aborts on stop.
 */
export async function askForPermission(
  call: PendingToolCall,
  ctx: PermissionContext,
  deps: PermissionPromptDeps,
): Promise<void> {
  if (!deps.bot || !deps.chatId || !deps.session) return;
  void ctx;
  // YOLO short-circuit: resolve immediately without rendering a prompt.
  // Mirrors the TUI's `/yolo` flag — once set, every tool call passes.
  if (deps.yolo) {
    deps.resolver.resolvePending(call.callId, { mode: 'allow', reason: 'yolo mode' });
    return;
  }
  const keyboard = new InlineKeyboard()
    .text('Allow once', `perm:${call.callId}:allow`)
    .text('Allow session', `perm:${call.callId}:allow_session`)
    .row()
    .text('Deny', `perm:${call.callId}:deny`);
  const description = deps.session.tools.get(call.name)?.description ?? '';
  const summary =
    `🔐 Tool permission requested\n` +
    `Tool: ${call.name}\n` +
    (description ? `Desc: ${description}\n` : '') +
    `Input: ${truncate(JSON.stringify(call.input), 300)}`;
  try {
    await deps.bot.api.sendMessage(deps.chatId, summary, { reply_markup: keyboard });
  } catch (err) {
    deps.logger?.warn('permission send failed', { err: String(err) });
    deps.resolver.resolvePending(call.callId, { mode: 'deny', reason: 'unable to render prompt' });
  }
}
