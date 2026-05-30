import {
  asToolCallId,
  buildSystemPromptWithSkills,
  collectProviderStream,
  createStuckLoopDetector,
  dispatchToolCall,
  isContextOverflowError,
  projectMessages,
  runCompactionIfNeeded,
  runElisionIfNeeded,
  usageEventFields,
  type CollectedToolUse,
  type ModeContext,
  type MoxxyEvent,
  type ProjectedMessages,
  type StuckLoopDetector,
} from '@moxxy/sdk';

export const TOOL_USE_MODE_NAME = 'tool-use';

export async function* runToolUseMode(ctx: ModeContext): AsyncIterable<MoxxyEvent> {
  // High soft cap as a safety net against truly runaway modes (network
  // glitch causing an infinite retry, bad prompt, etc.) — primary
  // termination signal is the stuck-loop detector, which catches the
  // common "model keeps calling the same tool" case ~10 iterations in.
  const maxIterations = ctx.maxIterations ?? 500;
  const detector = createStuckLoopDetector();
  // Reactive-compaction budget per overflow episode. If the provider keeps
  // rejecting for context size even after compacting this many times, give up
  // (the overflow is in the recent, un-compactable tail). Reset on any clean
  // provider call so a long turn can recover from multiple overflow episodes.
  const MAX_REACTIVE_COMPACTIONS = 2;
  let reactiveCompactions = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (ctx.signal.aborted) {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: 'signal aborted',
      });
      return;
    }

    yield await ctx.emit({
      type: 'mode_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: TOOL_USE_MODE_NAME,
      iteration,
    });

    // Auto-compact before composing the next provider request. If the
    // active compactor's `shouldCompact` returns true, this appends a
    // compaction event onto the log — projectMessagesFromLog (called
    // by buildMessages) honors it, so the model sees a summarized
    // prefix instead of overflowing the window mid-loop.
    await runCompactionIfNeeded(ctx);
    // Turn-boundary elision (context-on-demand): stub old bulky tool output and
    // (when enabled) old text turns, recall-able on demand. Composes with
    // compaction over the same projection.
    await runElisionIfNeeded(ctx);

    const { messages, stablePrefixIndex } = buildMessages(ctx);
    yield await ctx.emit({
      type: 'provider_request',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      provider: ctx.provider.name,
      model: ctx.model,
    });

    const { text, toolUses, stopReason, error, usage } = await collectProviderStream(ctx, messages, {
      iteration,
      stablePrefixIndex,
    });

    yield await ctx.emit({
      type: 'provider_response',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      provider: ctx.provider.name,
      model: ctx.model,
      ...usageEventFields(usage),
    });

    if (error) {
      // The request was too big for the model's window: our token estimate
      // lagged the provider's real tokenizer, so the proactive compactor
      // didn't fire. Force a compaction and retry rather than dying — this is
      // the auto-compact-on-overflow path.
      if (
        isContextOverflowError(error.message) &&
        reactiveCompactions < MAX_REACTIVE_COMPACTIONS
      ) {
        reactiveCompactions += 1;
        const compacted = await runCompactionIfNeeded(ctx, { force: true });
        if (compacted) {
          yield await ctx.emit({
            type: 'error',
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            source: 'system',
            kind: 'retryable',
            message: 'context window exceeded — compacted older turns, retrying',
          });
          continue;
        }
      }
      yield await ctx.emit({
        type: 'error',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        kind: error.retryable ? 'retryable' : 'fatal',
        message: error.message,
      });
      if (!error.retryable) return;
      continue;
    }
    // Clean provider call — reset the overflow-recovery budget.
    reactiveCompactions = 0;

    const stuck = yield* emitRequestsAndDetectStuck(ctx, toolUses, detector);
    if (stuck) return;

    if (text || stopReason === 'end_turn' || toolUses.length === 0) {
      yield await ctx.emit({
        type: 'assistant_message',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        content: text,
        stopReason,
      });
    }

    // Execute whenever the model requested tools, regardless of stopReason.
    // Providers vary in how reliably they report `stopReason: 'tool_use'`
    // (Codex's Responses API doesn't carry one on `response.completed`, so
    // the provider has to infer it from emitted events). Trusting only
    // stopReason here meant a single provider mis-mapping silently dropped
    // tool calls — `tool_call_requested` would be emitted with no matching
    // `tool_result`, leaving an orphan pending dot and a stuck-looking UI.
    if (toolUses.length === 0) return;

    const exited = yield* executeToolUses(ctx, toolUses, iteration);
    if (exited) return;
  }

  yield await ctx.emit({
    type: 'error',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    kind: 'fatal',
    message: `tool-use loop exceeded maxIterations (${maxIterations})`,
  });
}

/** Emit tool_call_requested for each tool use and check the stuck-loop
 *  detector. Returns `true` when the detector tripped (caller should stop). */
async function* emitRequestsAndDetectStuck(
  ctx: ModeContext,
  toolUses: ReadonlyArray<CollectedToolUse>,
  detector: StuckLoopDetector,
): AsyncGenerator<MoxxyEvent, boolean, unknown> {
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
    const sig = detector.record(t.name, t.input);
    if (sig.stuck) {
      const how =
        sig.kind === 'near'
          ? 'against the same target (only volatile args like maxBytes varied)'
          : 'with identical input';
      yield await ctx.emit({
        type: 'error',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        kind: 'fatal',
        message:
          `tool-use loop aborted — detected stuck pattern: tool "${t.name}" called ` +
          `${sig.count} times ${how}. The model is likely looping on the same call; ` +
          `reset or rephrase.`,
      });
      return true;
    }
  }
  return false;
}

/** Execute tool uses, handling mid-batch abort. Returns `true` when the
 *  caller should `return` (abort observed). */
async function* executeToolUses(
  ctx: ModeContext,
  toolUses: ReadonlyArray<CollectedToolUse>,
  iteration: number,
): AsyncGenerator<MoxxyEvent, boolean, unknown> {
  // Tracks tool_call_requested events that haven't yet emitted a paired
  // tool_result. On any early-exit (abort, unexpected throw), we synthesize
  // results for the leftovers so the event log can't end with orphan
  // tool_call_requested events.
  const unresolved = new Set<string>(toolUses.map((t) => t.id));

  for (const t of toolUses) {
    if (ctx.signal.aborted) {
      for (const orphanId of unresolved) {
        yield await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId: asToolCallId(orphanId),
          ok: false,
          error: { kind: 'aborted', message: 'turn aborted before tool ran' },
        });
      }
      unresolved.clear();
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: 'signal aborted during tool execution',
      });
      return true;
    }

    try {
      yield* dispatchToolCall(ctx, t, iteration);
    } finally {
      unresolved.delete(t.id);
    }
  }
  return false;
}

function buildMessages(ctx: ModeContext): ProjectedMessages {
  // Compose the system prompt with the skill catalog so the model knows
  // which playbooks exist; without this skills are invisible to the
  // model and it falls back to ad-hoc tool calls (the classic
  // `web_fetch instead of media-digest skill` symptom).
  const systemPrompt = buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list());
  return projectMessages(ctx, { ...(systemPrompt ? { systemPrompt } : {}) });
}
