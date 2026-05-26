import {
  asToolCallId,
  buildSystemPromptWithSkills,
  collectProviderStream,
  projectMessagesFromLog,
  runCompactionIfNeeded,
  runElisionIfNeeded,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

import { DEVELOPER_MODE_NAME, VERIFY_MAX_ITERATIONS, VERIFY_SYSTEM_PROMPT } from './constants.js';
import { dispatchToolCall } from './tool-dispatch.js';

/**
 * Window + threshold for the verify-phase stuck-loop detector. Verify
 * is meant to be one Bash + one report — if the model calls the same
 * Bash twice in a row, that's already a wasted iteration; three times
 * means the model is genuinely looping (the screenshotted bug pattern
 * was 6 identical `npm run lint && npm run build` calls in a row).
 */
const VERIFY_STUCK_WINDOW = 4;
const VERIFY_STUCK_THRESHOLD = 2;

/**
 * Run the verify sub-loop: ask the model to run tests/build, then report
 * SUMMARY + COMMIT blocks. Returns the model's final text (the body the
 * caller parses), or null on abort/fatal-error (already emitted).
 *
 * Uses the same tool-use shape as mode-tool-use so the model can run any
 * Bash command it needs to verify — we don't constrain the toolset here,
 * just the system prompt that drives the turn.
 */
export async function* runVerifyPhase(
  ctx: ModeContext,
): AsyncGenerator<MoxxyEvent, string | null, unknown> {
  let finalText = '';
  // Sliding window of recent (toolName, input) hashes inside this verify
  // phase only — mode-tool-use's detector covers the implementation
  // phase, but verify runs after that returns and has its own loop. The
  // original bug had the model burn 6 iterations re-running the same
  // `npm run lint && npm run build` after it had already passed.
  const recentCalls: string[] = [];

  for (let iteration = 1; iteration <= VERIFY_MAX_ITERATIONS; iteration++) {
    if (ctx.signal.aborted) return null;

    yield await ctx.emit({
      type: 'mode_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: DEVELOPER_MODE_NAME,
      iteration,
    });

    await runCompactionIfNeeded(ctx);
    await runElisionIfNeeded(ctx);

    const baseSystem =
      buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? ctx.systemPrompt ?? '';
    const systemPrompt = baseSystem
      ? `${VERIFY_SYSTEM_PROMPT}\n\n${baseSystem}`
      : VERIFY_SYSTEM_PROMPT;
    const messages = projectMessagesFromLog(ctx, {
      systemPrompt,
      trailingUserText:
        'The implementation phase is done. Now run the verify command(s) and reply with the SUMMARY: / COMMIT: blocks exactly as specified.',
    });

    await ctx.emit({
      type: 'provider_request',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      provider: ctx.provider.name,
      model: ctx.model,
    });

    const { text, toolUses, stopReason, error } = await collectProviderStream(ctx, messages, {
      iteration,
    });

    await ctx.emit({
      type: 'provider_response',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      provider: ctx.provider.name,
      model: ctx.model,
    });

    if (error) {
      yield await ctx.emit({
        type: 'error',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        kind: error.retryable ? 'retryable' : 'fatal',
        message: `developer.verify: ${error.message}`,
      });
      if (!error.retryable) return null;
      continue;
    }

    if (text) {
      finalText = text;
      yield await ctx.emit({
        type: 'assistant_message',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        content: text,
        stopReason,
      });
    }

    if (toolUses.length === 0) {
      // Model stopped with no more tool calls — verify phase is done.
      return finalText;
    }

    for (const t of toolUses) {
      // Stuck-loop check BEFORE dispatching: if the model has called
      // the same (tool, input) pair `VERIFY_STUCK_THRESHOLD` times in
      // the recent window, bail rather than burn the cap on identical
      // calls. We still return finalText (possibly empty) so the
      // developer-loop can decide whether to proceed to the commit gate.
      const key = `${t.name}|${stableInput(t.input)}`;
      recentCalls.push(key);
      if (recentCalls.length > VERIFY_STUCK_WINDOW) recentCalls.shift();
      const repeats = recentCalls.filter((k) => k === key).length;
      if (repeats >= VERIFY_STUCK_THRESHOLD) {
        yield await ctx.emit({
          type: 'error',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          kind: 'fatal',
          message:
            `developer.verify: detected stuck pattern — tool "${t.name}" called ` +
            `${repeats} times with identical input. Stopping verify phase; ` +
            `proceeding to commit gate with whatever summary the model has produced.`,
        });
        return finalText;
      }

      yield await ctx.emit({
        type: 'tool_call_requested',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        callId: asToolCallId(t.id),
        name: t.name,
        input: t.input,
      });
      await dispatchToolCall(ctx, t, iteration);
    }
  }

  // Hit cap without the model declaring it's done. Surface what we have;
  // parser will return nulls if the format isn't there.
  return finalText;
}

function stableInput(input: unknown): string {
  if (input === null || input === undefined) return 'null';
  if (typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) {
    return '[' + input.map((v) => stableInput(v)).join(',') + ']';
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableInput(v)).join(',') + '}';
}
