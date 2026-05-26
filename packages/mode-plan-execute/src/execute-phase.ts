import {
  asToolCallId,
  buildSystemPromptWithSkills,
  collectProviderStream,
  projectMessagesFromLog,
  runCompactionIfNeeded,
  runElisionIfNeeded,
  usageEventFields,
  type ModeContext,
} from '@moxxy/sdk';

import { PLAN_EXECUTE_MODE_NAME, PLAN_PLUGIN_ID } from './constants.js';
import { dispatchToolCall } from './tool-dispatch.js';

/**
 * Execute one plan step as a small tool-use sub-loop. Returns `true` when
 * the step concluded cleanly (model stopped tool-calling, or the
 * stuck-call detector tripped), `false` when the iteration cap was hit.
 */
export async function executeStep(
  ctx: ModeContext,
  step: string,
  stepIndex: number,
  allSteps: ReadonlyArray<string>,
  maxIterations: number,
): Promise<boolean> {
  // The plan itself lives in the log as an assistant_message emitted
  // right after planning, so projection will surface it automatically.
  // We still need a forceful per-step nudge so the model actually uses
  // tools rather than narrating — the previous prompt "Focus on this
  // step now: X" sounded conversational and the model would reply with
  // "Sure, I'll do X" without ever calling a tool, then the loop would
  // advance and burn another step doing nothing.
  const stepNudge = buildStepNudge(step, stepIndex, allSteps.length);

  // Track tool-call signatures within this step. If the model repeats
  // the exact same call (same name + same input), it's stuck in a
  // pointless loop — observed empirically when the model "writes the
  // same step1.md four times in a row" because nothing in the
  // conversation tells it the work is done. We treat the second
  // identical call as the signal that the step is finished.
  const callSignatures = new Set<string>();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (ctx.signal.aborted) return false;

    await ctx.emit({
      type: 'mode_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: PLAN_EXECUTE_MODE_NAME,
      iteration,
    });

    // Auto-compact before each provider call so a long execution
    // phase can't blow the context window without warning. See
    // runCompactionIfNeeded() for the no-op fallbacks.
    await runCompactionIfNeeded(ctx);
    await runElisionIfNeeded(ctx);

    const messages = projectMessagesFromLog(ctx, {
      systemPrompt:
        buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? ctx.systemPrompt,
      trailingUserText: stepNudge,
    });
    await ctx.emit({
      type: 'provider_request',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      provider: ctx.provider.name,
      model: ctx.model,
    });

    const { text, toolUses, stopReason, usage } = await collectProviderStream(ctx, messages, {
      iteration,
    });

    await ctx.emit({
      type: 'provider_response',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      provider: ctx.provider.name,
      model: ctx.model,
      ...usageEventFields(usage),
    });

    // Surface any spoken text from the model. Note: we do NOT emit
    // tool_call_requested here yet — emitting before we know we'll
    // actually execute leaves orphan requests in the log if the model
    // signaled end_turn alongside the tool_use. The next step's
    // projection then sees pending tool calls with no results and the
    // model tends to re-request them, which is exactly the infinite-loop
    // shape the user hit.
    if (text) {
      await ctx.emit({
        type: 'assistant_message',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        content: text,
        stopReason,
      });
    }

    // Step done if the model didn't ask to use tools. We deliberately do
    // NOT gate on stopReason — some providers (notably codex's Responses
    // API) don't report stop_reason='tool_use' reliably, and a single
    // mis-mapping would silently skip every tool call in the step.
    // toolUses.length is the source of truth.
    if (toolUses.length === 0) return true;

    // Detect repeat calls BEFORE dispatching. If every tool use in this
    // iteration was already seen in a prior iteration of the SAME step,
    // the model is stuck rewriting the same file / running the same
    // command over and over. Treat the step as done so we move on
    // instead of burning the full per-step iteration cap.
    const newCalls = toolUses.filter((t) => !callSignatures.has(signatureFor(t.name, t.input)));
    if (newCalls.length === 0) {
      await ctx.emit({
        type: 'plugin_event',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'plugin',
        pluginId: PLAN_PLUGIN_ID,
        subtype: 'plan_step_repeat_detected',
        payload: {
          stepIndex,
          step,
          iteration,
          repeatedCalls: toolUses.map((t) => t.name),
        },
      });
      return true;
    }

    for (const t of toolUses) {
      callSignatures.add(signatureFor(t.name, t.input));

      // Emit the request RIGHT BEFORE we dispatch + execute it so every
      // tool_call_requested in the log has a matching outcome.
      await ctx.emit({
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
  return false;
}

function buildStepNudge(step: string, stepIndex: number, total: number): string {
  return (
    `STEP ${stepIndex + 1}/${total}: ${step}\n\n` +
    `Use the available tools to do this step now. Do not summarize, do ` +
    `not explain what you will do — just call the tools. When the step is ` +
    `concretely done, reply with one short line of confirmation and stop. ` +
    `If you cannot make progress with tools, say exactly what's blocking ` +
    `you in one sentence and stop.`
  );
}

function signatureFor(name: string, input: unknown): string {
  return `${name}::${JSON.stringify(input ?? null)}`;
}
