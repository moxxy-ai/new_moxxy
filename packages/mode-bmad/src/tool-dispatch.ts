import {
  asToolCallId,
  type CollectedToolUse,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

/**
 * Run plugin hooks → permission resolver → tool. Yields the
 * approved/denied/result events so the caller can stream them out.
 */
export async function* dispatchToolCall(
  ctx: ModeContext,
  t: CollectedToolUse,
  iteration: number,
): AsyncGenerator<MoxxyEvent, void, unknown> {
  const callId = asToolCallId(t.id);

  const verdict = await ctx.hooks.dispatchToolCall({
    sessionId: ctx.sessionId,
    cwd: '',
    log: ctx.log,
    env: {},
    turnId: ctx.turnId,
    iteration,
    call: { callId, name: t.name, input: t.input },
  });
  let actualInput = t.input;
  if (verdict.action === 'rewrite') actualInput = verdict.input;
  if (verdict.action === 'deny') {
    yield* emitDenied(ctx, callId, verdict.reason ?? 'denied by hook', 'hook');
    return;
  }

  const decision = await ctx.permissions.check(
    { callId, name: t.name, input: actualInput },
    { sessionId: String(ctx.sessionId), toolDescription: ctx.tools.get(t.name)?.description },
  );
  if (decision.mode === 'deny') {
    yield* emitDenied(ctx, callId, decision.reason ?? 'denied', 'resolver');
    return;
  }
  yield await ctx.emit({
    type: 'tool_call_approved',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    callId,
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
      callId,
      ok: true,
      output,
    });
  } catch (err) {
    yield await ctx.emit({
      type: 'tool_result',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'tool',
      callId,
      ok: false,
      error: {
        kind: ctx.signal.aborted ? 'aborted' : 'threw',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function* emitDenied(
  ctx: ModeContext,
  callId: ReturnType<typeof asToolCallId>,
  reason: string,
  decidedBy: 'hook' | 'resolver',
): AsyncGenerator<MoxxyEvent, void, unknown> {
  yield await ctx.emit({
    type: 'tool_call_denied',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    callId,
    decidedBy,
    reason,
  });
  yield await ctx.emit({
    type: 'tool_result',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'tool',
    callId,
    ok: false,
    error: { kind: 'denied', message: reason },
  });
}
