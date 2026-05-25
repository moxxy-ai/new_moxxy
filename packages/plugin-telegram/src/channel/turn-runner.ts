import type { Bot, Context } from 'grammy';
import type { ClientSession as Session } from '@moxxy/sdk';
import type { FramePump } from './frame-pump.js';
import type { TypingIndicator } from './typing-indicator.js';

export interface TurnRunnerLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface TurnRunnerDeps {
  readonly session: Session;
  readonly bot: Bot | null;
  readonly framePump: FramePump;
  readonly typing: TypingIndicator;
  readonly logger?: TurnRunnerLogger;
}

export interface TurnRunnerOptions {
  readonly chatId: number;
  readonly text: string;
  readonly model: string | undefined;
  readonly controller: AbortController;
}

/**
 * Drive a single user turn end-to-end: kick off typing, subscribe the
 * frame pump to session events, run the turn through `runTurn`, flush
 * the final frame, and unwind state in `finally`.
 *
 * The controller is owned by the caller so /cancel can abort just this
 * turn without poisoning the session-level signal.
 */
export async function runUserTurn(
  ctx: Context,
  deps: TurnRunnerDeps,
  opts: TurnRunnerOptions,
): Promise<void> {
  const { session, bot, framePump, typing, logger } = deps;
  const { chatId, text, model, controller } = opts;

  framePump.beginTurn(chatId);
  // Kick off "typing…" right away so the user gets immediate feedback.
  // Don't send an ellipsis placeholder message — the typing indicator
  // IS the placeholder. The frame pump lazily sends the first real
  // frame when there's content to display, then edits that message for
  // every subsequent frame.
  typing.start(bot, chatId);

  const unsubscribe = session.log.subscribe((event) => {
    const frame = framePump.renderState.accept(event);
    if (frame.hasUpdate) framePump.scheduleEdit();
  });

  try {
    for await (const _event of session.runTurn(text, {
      ...(model ? { model } : {}),
      signal: controller.signal,
    })) {
      void _event;
    }
    await framePump.flush(true);
  } catch (err) {
    logger?.warn('telegram turn failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    try {
      await ctx.reply(`Turn failed: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* ignore */
    }
  } finally {
    typing.stop();
    unsubscribe();
    framePump.endTurn();
  }
}
