import type { Context } from 'grammy';
import type { ClientSession as Session } from '@moxxy/sdk';
import type { TelegramApprovalResolver } from '../approval.js';
import type { TelegramPermissionResolver } from '../permission.js';
import type { ChannelHandle } from '@moxxy/sdk';
import type { FramePump } from './frame-pump.js';
import { runSlash } from './slash-handler.js';
import type { AwaitingApprovalText } from './callback-handler.js';
import type { PairingHandler } from './pairing-handler.js';

export interface TextHandlerState {
  readonly session: Session | null;
  readonly model: string | undefined;
  readonly activeModelOverride: string | null;
  readonly yolo: boolean;
  readonly busy: boolean;
  readonly turnController: AbortController | null;
  readonly awaitingApprovalText: AwaitingApprovalText | null;
  readonly handle: ChannelHandle | null;
}

export interface TextHandlerDeps {
  readonly pairing: PairingHandler;
  readonly approvalResolver: TelegramApprovalResolver;
  readonly permissionResolver: TelegramPermissionResolver;
  readonly framePump: FramePump;
}

export interface TextHandlerCallbacks {
  readonly setAwaitingApprovalText: (state: AwaitingApprovalText | null) => void;
  readonly toggleYolo: () => boolean;
  readonly setYolo: (value: boolean) => void;
  readonly runUserTurn: (ctx: Context, chatId: number, text: string) => Promise<void>;
}

/**
 * Top-level dispatch for inbound text messages: authorization gate,
 * awaiting-approval-text capture, /cancel, slash routing, and finally
 * the user-turn path.
 */
export async function handleTextMessage(
  ctx: Context,
  state: TextHandlerState,
  deps: TextHandlerDeps,
  cb: TextHandlerCallbacks,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  if (!chatId || !text) return;

  if (!deps.pairing.isAuthorized(chatId)) {
    await ctx.reply(
      'This bot is paired with a different chat (or not paired yet). Run `moxxy telegram pair` to (re-)pair.',
    );
    return;
  }

  // Capture awaiting-text BEFORE the busy guard so the user can answer
  // an approval text prompt even while the strategy is technically
  // still mid-turn (it's pending on us).
  if (state.awaitingApprovalText) {
    const { approvalId, optionId } = state.awaitingApprovalText;
    cb.setAwaitingApprovalText(null);
    const handled = deps.approvalResolver.resolvePendingWithText(approvalId, optionId, text);
    if (handled) {
      await ctx.reply(`✓ submitted (${optionId})`);
    } else {
      await ctx.reply('that approval is no longer pending');
    }
    return;
  }

  // /cancel works even while busy; everything else routes through
  // runSlash or the user-turn path.
  if (text === '/cancel') {
    if (state.turnController && !state.turnController.signal.aborted) {
      state.turnController.abort('user cancel');
      await ctx.reply('cancelling current turn…');
    } else {
      await ctx.reply('nothing to cancel.');
    }
    return;
  }

  if (text.startsWith('/')) {
    await runSlash(
      ctx,
      text,
      {
        session: state.session,
        model: state.model,
        activeModelOverride: state.activeModelOverride,
        yolo: state.yolo,
      },
      {
        toggleYolo: cb.toggleYolo,
        performSessionAction: (c, action, notice) =>
          performSessionAction(c, action, notice, state, deps, cb),
      },
    );
    return;
  }

  if (state.busy) {
    await ctx.reply('I am still working on the previous prompt. Send /cancel to abort it.');
    return;
  }

  await cb.runUserTurn(ctx, chatId, text);
}

/**
 * Channel-side handler for `session-action` outputs from registered
 * commands. The TUI does the same thing; both channels translate the
 * action into their own UI semantics (Telegram = reply text, Ink =
 * setState + exit).
 */
async function performSessionAction(
  ctx: Context,
  action: 'new' | 'clear' | 'exit',
  notice: string | undefined,
  state: TextHandlerState,
  deps: TextHandlerDeps,
  cb: TextHandlerCallbacks,
): Promise<void> {
  if (!state.session) return;
  if (action === 'exit') {
    await ctx.reply(notice ?? 'closing Telegram channel');
    if (state.handle) await state.handle.stop('user /exit');
    return;
  }
  if (action === 'clear') {
    deps.framePump.resetRenderer();
    if (notice) await ctx.reply(`✓ ${notice}`);
    return;
  }
  if (action === 'new') {
    if (state.turnController && !state.turnController.signal.aborted) {
      state.turnController.abort('user reset');
    }
    state.session.log.clear();
    deps.framePump.resetRenderer();
    cb.setYolo(false);
    cb.setAwaitingApprovalText(null);
    deps.approvalResolver.abortAll('session reset');
    deps.permissionResolver.abortAll('session reset');
    await ctx.reply(`✓ ${notice ?? 'new session — conversation history cleared'}`);
  }
}
