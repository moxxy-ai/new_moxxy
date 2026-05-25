import {
  asToolCallId,
  type CollectedToolUse,
  type ModeContext,
} from '@moxxy/sdk';

/**
 * Run plugin hooks → permission resolver → tool. Emits the
 * approved/denied/result events directly on `ctx`. Unlike
 * `loop-tool-use`'s variant, this one is a plain async function (not a
 * generator) — the caller already lives inside an async function and
 * shouldn't have to yield* every single event.
 */
export async function dispatchToolCall(
  ctx: ModeContext,
  t: CollectedToolUse,
  iteration: number,
): Promise<void> {
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
    const reason = verdict.reason ?? 'denied by hook';
    await emitDenied(ctx, callId, reason, 'hook');
    return;
  }

  const decision = await ctx.permissions.check(
    { callId, name: t.name, input: actualInput },
    { sessionId: String(ctx.sessionId), toolDescription: ctx.tools.get(t.name)?.description },
  );
  if (decision.mode === 'deny') {
    await emitDenied(ctx, callId, decision.reason ?? 'denied', 'resolver');
    return;
  }
  await ctx.emit({
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
    await ctx.emit({
      type: 'tool_result',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'tool',
      callId,
      ok: true,
      output,
    });
  } catch (err) {
    await ctx.emit({
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

async function emitDenied(
  ctx: ModeContext,
  callId: ReturnType<typeof asToolCallId>,
  reason: string,
  decidedBy: 'hook' | 'resolver',
): Promise<void> {
  await ctx.emit({
    type: 'tool_call_denied',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    callId,
    decidedBy,
    reason,
  });
  await ctx.emit({
    type: 'tool_result',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'tool',
    callId,
    ok: false,
    error: { kind: 'denied', message: reason },
  });
}
