import {
  defineMode,
  definePlugin,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

import { runPlanApprovalGate } from './approval.js';
import {
  MAX_PLAN_STEPS,
  MAX_REDRAFTS,
  PLAN_EXECUTE_MODE_NAME,
  PLAN_PLUGIN_ID,
} from './constants.js';
import { executeStep } from './execute-phase.js';
import { parsePlan } from './parse-plan.js';
import { collectPlan } from './plan-phase.js';

export { PLAN_EXECUTE_MODE_NAME } from './constants.js';
export { parsePlan } from './parse-plan.js';

export const planExecuteMode = defineMode({
  name: PLAN_EXECUTE_MODE_NAME,
  run: runPlanExecuteMode,
});

export const planExecuteModePlugin = definePlugin({
  name: '@moxxy/mode-plan-execute',
  version: '0.0.0',
  modes: [planExecuteMode],
});

export default planExecuteModePlugin;

async function* runPlanExecuteMode(ctx: ModeContext): AsyncIterable<MoxxyEvent> {
  if (ctx.signal.aborted) {
    yield await ctx.emit({
      type: 'abort',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      reason: 'aborted before plan',
    });
    return;
  }

  yield await ctx.emit({
    type: 'mode_iteration',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    strategy: PLAN_EXECUTE_MODE_NAME,
    iteration: 0,
    routing: 'unresolved',
  });

  const planning = yield* runPlanningPhase(ctx);
  if (planning === null) return;
  const { steps } = planning;

  // Phase 2: execute each step. Two caps:
  //   - per-step iteration cap (model can call tools up to N times for one step)
  //   - turn-wide cap on total steps × iterations so a runaway plan can't
  //     burn through hundreds of tool calls. Esc still cancels mid-loop.
  const maxIterationsPerStep = ctx.maxIterations ?? 6;
  if (steps.length > MAX_PLAN_STEPS) {
    yield await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: 'fatal',
      message: `plan-execute: refusing a ${steps.length}-step plan (cap is ${MAX_PLAN_STEPS}). Rephrase as a smaller scope or switch to the tool-use mode.`,
    });
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    if (ctx.signal.aborted) {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: 'aborted between steps',
      });
      return;
    }

    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: PLAN_PLUGIN_ID,
      subtype: 'plan_step_started',
      payload: { index: i, step: steps[i]! },
    });

    const completed = await executeStep(ctx, steps[i]!, i, steps, maxIterationsPerStep);

    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: PLAN_PLUGIN_ID,
      subtype: 'plan_step_completed',
      payload: { index: i, step: steps[i]!, completed },
    });

    if (!completed) {
      yield await ctx.emit({
        type: 'error',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        kind: 'fatal',
        message: `plan-execute: step ${i + 1} did not complete cleanly: "${steps[i]}"`,
      });
      return;
    }
  }

  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: PLAN_PLUGIN_ID,
    subtype: 'plan_completed',
    payload: { steps: steps.length },
  });
}

/**
 * Phase 1: produce a plan, with an optional user-approval gate. When
 * `ctx.approval` is set (TUI), we ask the user to validate the plan after
 * each draft. On "redraft" we re-run planning with their feedback as
 * extra context; on "cancel" we abort the turn. Returns the parsed steps
 * + plan text, or `null` when the phase terminated (no actionable plan,
 * user cancellation, redraft cap exceeded, abort).
 */
async function* runPlanningPhase(
  ctx: ModeContext,
): AsyncGenerator<MoxxyEvent, { planText: string; steps: string[] } | null, unknown> {
  let redraftFeedback: string | null = null;
  let redraftCount = 0;

  while (true) {
    if (ctx.signal.aborted) {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: 'aborted during planning',
      });
      return null;
    }

    const planText = await collectPlan(ctx, redraftFeedback);
    if (planText === null) return null;
    const steps = parsePlan(planText);

    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: PLAN_PLUGIN_ID,
      subtype: 'plan_created',
      payload: { text: planText, steps, redraft: redraftCount },
    });

    if (steps.length === 0) {
      // No actionable plan — surface as a final assistant message and stop.
      yield await ctx.emit({
        type: 'assistant_message',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        content: planText,
        stopReason: 'end_turn',
      });
      return null;
    }

    const gate = await runPlanApprovalGate(ctx, planText, steps.length, redraftCount);
    redraftCount = gate.redraftCount;

    if (gate.outcome.kind === 'cancel') {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'user',
        reason: 'plan rejected by user',
      });
      return null;
    }
    if (gate.outcome.kind === 'redraft-cap-exceeded') {
      yield await ctx.emit({
        type: 'error',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        kind: 'fatal',
        message: `plan-execute: redrafted ${MAX_REDRAFTS}× without approval; aborting.`,
      });
      return null;
    }
    if (gate.outcome.kind === 'redraft') {
      redraftFeedback = gate.outcome.feedback;
      continue;
    }

    // Materialize the approved plan as an assistant_message so projection
    // picks it up in per-step execution. Only emit the FINAL plan —
    // earlier redrafts shouldn't pollute the conversation the model sees.
    yield await ctx.emit({
      type: 'assistant_message',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'model',
      content: planText,
      stopReason: 'end_turn',
    });
    return { planText, steps };
  }
}
