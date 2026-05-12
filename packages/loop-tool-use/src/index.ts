import {
  asToolCallId,
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

    if (stopReason !== 'tool_use' || toolUses.length === 0) return;

    for (const t of toolUses) {
      if (ctx.signal.aborted) {
        yield await ctx.emit({
          type: 'abort',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          reason: 'signal aborted during tool execution',
        });
        return;
      }

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
  return projectMessagesFromLog(ctx, { systemPrompt: ctx.systemPrompt });
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
