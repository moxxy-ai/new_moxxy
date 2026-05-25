import {
  asToolCallId,
  collectProviderStream,
  runCompactionIfNeeded,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

import { BMAD_MODE_NAME, type Artifacts } from '../constants.js';
import { dispatchToolCall } from '../tool-dispatch.js';
import {
  buildBmadContext,
  buildDevNudge,
  buildImplementationMessages,
} from './implementation-messages.js';

/**
 * Implementation phase = a standard tool-use loop with the developer
 * persona driving execution against the artifacts already in the log
 * (analyst brief, story list, architect design). One continuous loop —
 * the model flows across stories naturally rather than being herded
 * story-by-story. Returns `false` when an abort/error has already been
 * emitted by this generator; the caller should `return` immediately in
 * that case.
 */
export async function* runImplementationLoop(
  ctx: ModeContext,
  artifacts: Artifacts,
): AsyncGenerator<MoxxyEvent, boolean, unknown> {
  // Match loop-tool-use's defaults — see its file header. Stuck-loop
  // detection in BMAD is left to the developer phase's parent
  // verification gate (BMAD checkpoints between stories); the cap
  // here is just a safety net.
  const maxIterations = ctx.maxIterations ?? 500;

  const bmadContext = buildBmadContext(artifacts);
  const devNudge = buildDevNudge(artifacts.stories);

  let producedAnyOutput = false; // Tracks whether the loop did any visible work.

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (ctx.signal.aborted) {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: 'aborted during implementation',
      });
      return false;
    }

    yield await ctx.emit({
      type: 'mode_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: BMAD_MODE_NAME,
      iteration,
    });

    // Auto-compact before each provider call — long BMAD runs
    // (analyst + architect + dev across many stories) are the most
    // context-heavy workflow we ship, so this is the mode that
    // benefits from auto-compaction the most.
    await runCompactionIfNeeded(ctx);

    const messages = buildImplementationMessages(
      ctx,
      iteration === 1 ? bmadContext : null,
      iteration === 1 ? devNudge : null,
    );

    yield await ctx.emit({
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

    yield await ctx.emit({
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
        message: error.message,
      });
      if (!error.retryable) return false;
      continue;
    }

    if (text) {
      yield await ctx.emit({
        type: 'assistant_message',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        content: text,
        stopReason,
      });
      producedAnyOutput = true;
    }

    // Gate on toolUses, NOT stopReason. Some providers (codex)
    // under-report stop_reason='tool_use', so keying on stopReason would
    // silently skip tool execution. If there are tools to run, run them;
    // otherwise wrap up the phase.
    if (toolUses.length === 0) {
      // First-iteration silent end_turn is the bug signature that used
      // to make the implementation phase look like it never ran.
      // Surface it as a hint instead of pretending the work is done.
      if (iteration === 1 && !producedAnyOutput) {
        yield await ctx.emit({
          type: 'error',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          kind: 'fatal',
          message:
            'bmad: developer phase ended with no output or tool calls on its first ' +
            'iteration — the model accepted the BMAD context but produced nothing. ' +
            'Try re-running with the `tool-use` loop, or send a follow-up prompt like ' +
            '"execute the plan above" to kick the developer off.',
        });
        return false;
      }
      return true;
    }
    producedAnyOutput = true;

    for (const t of toolUses) {
      yield await ctx.emit({
        type: 'tool_call_requested',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        callId: asToolCallId(t.id),
        name: t.name,
        input: t.input,
      });
      yield* dispatchToolCall(ctx, t, iteration);
    }
  }
  // Iteration cap reached — treat as completed so the outer phase
  // wrapper still emits `bmad_phase_completed`. The model may not have
  // finished every story; that's expected when the user request is large.
  return true;
}
