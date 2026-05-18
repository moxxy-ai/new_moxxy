import {
  asToolCallId,
  buildSystemPromptWithSkills,
  collectProviderStream,
  defineLoopStrategy,
  definePlugin,
  projectMessagesFromLog,
  type CollectedToolUse,
  type LoopContext,
  type MoxxyEvent,
  type ToolCallVerdict,
} from '@moxxy/sdk';

export const TOOL_USE_LOOP_NAME = 'tool-use';

export type { CollectedToolUse };

export const toolUseLoop = defineLoopStrategy({
  name: TOOL_USE_LOOP_NAME,
  run: runToolUseLoop,
});

export const toolUseLoopPlugin = definePlugin({
  name: '@moxxy/loop-tool-use',
  version: '0.0.0',
  loopStrategies: [toolUseLoop],
});

export default toolUseLoopPlugin;

async function* runToolUseLoop(ctx: LoopContext): AsyncIterable<MoxxyEvent> {
  const maxIterations = ctx.maxIterations ?? 50;

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
      type: 'loop_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: TOOL_USE_LOOP_NAME,
      iteration,
    });

    const messages = buildMessages(ctx);
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
      if (!error.retryable) return;
      continue;
    }

    for (const t of toolUses) {
      const callId = asToolCallId(t.id);
      const requested = await ctx.emit({
        type: 'tool_call_requested',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        callId,
        name: t.name,
        input: t.input,
      });
      yield requested;
    }

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
    // If there genuinely are no tools to run, end the turn.
    if (toolUses.length === 0) return;

    // Tracks tool_call_requested events that haven't yet emitted a paired
    // tool_result. On any early-exit (abort, unexpected throw), we synthesize
    // results for the leftovers so the event log can't end with orphan
    // tool_call_requested events — those would leave the UI stuck on a
    // pending dot and the next provider call would see a missing tool_result.
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
        return;
      }

      try {
        const verdict = await ctx.hooks.dispatchToolCall({
          sessionId: ctx.sessionId,
          cwd: '',
          log: ctx.log,
          env: {},
          turnId: ctx.turnId,
          iteration,
          call: { callId: asToolCallId(t.id), name: t.name, input: t.input },
        });
        let actualInput = t.input;
        if (verdict.action === 'rewrite') actualInput = verdict.input;

        const denyReason = hookDeny(verdict);
        if (denyReason) {
          yield await emitDenied(ctx, t, denyReason, 'hook');
          continue;
        }

        const decision = await ctx.permissions.check(
          { callId: asToolCallId(t.id), name: t.name, input: actualInput },
          { sessionId: String(ctx.sessionId), toolDescription: ctx.tools.get(t.name)?.description },
        );
        if (decision.mode === 'deny') {
          yield await emitDenied(ctx, t, decision.reason ?? 'denied by resolver', 'resolver');
          continue;
        }
        yield await ctx.emit({
          type: 'tool_call_approved',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          callId: asToolCallId(t.id),
          decidedBy: 'resolver',
          mode: decision.mode,
        });

        try {
          const output = await ctx.tools.execute(t.name, actualInput, ctx.signal, {
            callId: t.id,
            sessionId: String(ctx.sessionId),
            turnId: String(ctx.turnId),
            log: ctx.log,
            ...(ctx.subagents ? { subagents: ctx.subagents } : {}),
          });
          yield await ctx.emit({
            type: 'tool_result',
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            source: 'tool',
            callId: asToolCallId(t.id),
            ok: true,
            output,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const kind: 'aborted' | 'threw' = ctx.signal.aborted ? 'aborted' : 'threw';
          yield await ctx.emit({
            type: 'tool_result',
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            source: 'tool',
            callId: asToolCallId(t.id),
            ok: false,
            error: { kind, message },
          });
        }
      } catch (err) {
        // Defensive: a hook handler, permission resolver, or the emit
        // itself threw before we could produce a tool_result. Without this
        // catch the throw would propagate out of the generator, exiting
        // the loop and leaving this and any subsequent calls as orphan
        // tool_call_requested events — the very class of bug that prompted
        // this rework. Synthesize a failed result so the event log stays
        // well-formed.
        const message = err instanceof Error ? err.message : String(err);
        yield await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId: asToolCallId(t.id),
          ok: false,
          error: { kind: 'threw', message: `pre-execute failure: ${message}` },
        });
      } finally {
        unresolved.delete(t.id);
      }
    }
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

function buildMessages(ctx: LoopContext): ReadonlyArray<import('@moxxy/sdk').ProviderMessage> {
  // Compose the system prompt with the skill catalog so the model knows
  // which playbooks exist; without this skills are invisible to the
  // model and it falls back to ad-hoc tool calls (the classic
  // `web_fetch instead of media-digest skill` symptom).
  const systemPrompt = buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list());
  return projectMessagesFromLog(ctx, { ...(systemPrompt ? { systemPrompt } : {}) });
}

function hookDeny(verdict: ToolCallVerdict): string | null {
  return verdict.action === 'deny' ? verdict.reason : null;
}

async function emitDenied(
  ctx: LoopContext,
  t: CollectedToolUse,
  reason: string,
  by: 'hook' | 'resolver' | 'policy',
): Promise<MoxxyEvent> {
  await ctx.emit({
    type: 'tool_call_denied',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    callId: asToolCallId(t.id),
    decidedBy: by,
    reason,
  });
  return await ctx.emit({
    type: 'tool_result',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'tool',
    callId: asToolCallId(t.id),
    ok: false,
    error: { kind: 'denied', message: reason },
  });
}
