import {
  asPluginId,
  asToolCallId,
  buildSystemPromptWithSkills,
  collectProviderStream,
  defineLoopStrategy,
  definePlugin,
  projectMessagesFromLog,
  type LoopContext,
  type MoxxyEvent,
  type ProviderMessage,
} from '@moxxy/sdk';

export const PLAN_EXECUTE_LOOP_NAME = 'plan-execute';

const PLAN_PLUGIN_ID = asPluginId('@moxxy/loop-plan-execute');

const PLAN_SYSTEM_PROMPT = `Before doing anything, produce a numbered plan of 1-6 short steps. Format strictly:

PLAN:
1. <step>
2. <step>
...

Then stop. The runtime will execute each step as a focused turn.`;

export const planExecuteLoop = defineLoopStrategy({
  name: PLAN_EXECUTE_LOOP_NAME,
  run: runPlanExecuteLoop,
});

export const planExecuteLoopPlugin = definePlugin({
  name: '@moxxy/loop-plan-execute',
  version: '0.0.0',
  loopStrategies: [planExecuteLoop],
});

export default planExecuteLoopPlugin;

async function* runPlanExecuteLoop(ctx: LoopContext): AsyncIterable<MoxxyEvent> {
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
    type: 'loop_iteration',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    strategy: PLAN_EXECUTE_LOOP_NAME,
    iteration: 0,
    routing: 'unresolved',
  });

  // Phase 1: produce a plan, with an optional user-approval gate.
  // When ctx.planApproval is set (TUI), we ask the user to validate
  // the plan after each draft. On "redraft" we re-run planning with
  // their feedback as extra context; on "cancel" we abort the turn.
  let planText = '';
  let steps: string[] = [];
  let redraftFeedback: string | null = null;
  const MAX_REDRAFTS = 5;
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
      return;
    }

    const collected = await collectPlan(ctx, redraftFeedback);
    if (collected === null) return;
    planText = collected;
    steps = parsePlan(planText);

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
      return;
    }

    // Approval gate — only when a resolver is installed. Headless contexts
    // (-p / non-TTY) have no resolver and proceed straight to execution.
    if (ctx.approval) {
      const decision = await ctx.approval.confirm({
        title: 'Plan ready — review before execution',
        body: planText,
        kind: 'plan-execute.plan',
        defaultOptionId: 'approve',
        options: [
          {
            id: 'approve',
            label: 'Approve and run',
            hotkey: 'a',
            description: `Execute the ${steps.length} step${steps.length === 1 ? '' : 's'} above.`,
          },
          {
            id: 'redraft',
            label: 'Redraft with feedback',
            hotkey: 'r',
            requestsText: true,
            textPrompt: 'What should change about the plan?',
            description: 'Send feedback to the planner and get a new plan.',
          },
          {
            id: 'cancel',
            label: 'Cancel this turn',
            hotkey: 'c',
            danger: true,
          },
        ],
      });
      if (decision.optionId === 'cancel') {
        yield await ctx.emit({
          type: 'abort',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'user',
          reason: 'plan rejected by user',
        });
        return;
      }
      if (decision.optionId === 'redraft') {
        redraftCount += 1;
        if (redraftCount > MAX_REDRAFTS) {
          yield await ctx.emit({
            type: 'error',
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            source: 'system',
            kind: 'fatal',
            message: `plan-execute: redrafted ${MAX_REDRAFTS}× without approval; aborting.`,
          });
          return;
        }
        redraftFeedback = decision.text ?? null;
        continue; // loop back, collect a new plan
      }
      // optionId === 'approve' (or unknown — treat as approve) — fall through
    }

    // Materialize the approved plan as an assistant_message so projection
    // picks it up in per-step execution. Only emit the FINAL plan — earlier
    // redrafts shouldn't pollute the conversation the model sees.
    yield await ctx.emit({
      type: 'assistant_message',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'model',
      content: planText,
      stopReason: 'end_turn',
    });
    break;
  }

  // Phase 2: execute each step. Two caps:
  //   - per-step iteration cap (model can call tools up to N times for one step)
  //   - turn-wide cap on total steps × iterations so a runaway plan can't
  //     burn through hundreds of tool calls. Esc still cancels mid-loop.
  const maxIterationsPerStep = ctx.maxIterations ?? 6;
  const MAX_PLAN_STEPS = 12;
  if (steps.length > MAX_PLAN_STEPS) {
    yield await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: 'fatal',
      message: `plan-execute: refusing a ${steps.length}-step plan (cap is ${MAX_PLAN_STEPS}). Rephrase as a smaller scope or switch to the tool-use loop.`,
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

    const completed = await executeStep(
      ctx,
      steps[i]!,
      i,
      steps,
      planText,
      maxIterationsPerStep,
    );

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

async function collectPlan(
  ctx: LoopContext,
  redraftFeedback: string | null,
): Promise<string | null> {
  const userMessages = buildBaseMessages(ctx);
  // On redraft, append the user's feedback as an extra user turn so the
  // planner sees both the original request AND what they wanted changed.
  if (redraftFeedback) {
    userMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `The previous plan needs to be redrafted. Feedback from the user: ${redraftFeedback}\n\n` +
            `Produce a new PLAN block addressing this feedback.`,
        },
      ],
    });
  }
  // Include skills in the planner's view so plans can name skills as
  // steps (e.g. "Use the media-digest skill") instead of always routing
  // to generic tools like web_fetch.
  const systemWithSkills = buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? '';
  const planMessages: ProviderMessage[] = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: PLAN_SYSTEM_PROMPT + (systemWithSkills ? `\n\n${systemWithSkills}` : ''),
        },
      ],
    },
    ...userMessages,
  ];

  await ctx.emit({
    type: 'provider_request',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
  });

  let text = '';
  try {
    for await (const event of ctx.provider.stream({
      model: ctx.model,
      messages: planMessages,
      maxTokens: 1024,
      signal: ctx.signal,
    })) {
      if (event.type === 'text_delta') {
        text += event.delta;
        await ctx.emit({
          type: 'assistant_chunk',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'model',
          delta: event.delta,
        });
      } else if (event.type === 'error') {
        await ctx.emit({
          type: 'error',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          kind: event.retryable ? 'retryable' : 'fatal',
          message: event.message,
        });
        return null;
      }
    }
  } catch (err) {
    await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  await ctx.emit({
    type: 'provider_response',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
  });

  return text;
}

async function executeStep(
  ctx: LoopContext,
  step: string,
  stepIndex: number,
  allSteps: ReadonlyArray<string>,
  planText: string,
  maxIterations: number,
): Promise<boolean> {
  // The plan itself lives in the log now (as an assistant_message
  // emitted right after planning), so projection will surface it
  // automatically. We still need a forceful per-step nudge so the model
  // actually uses tools rather than narrating — the previous prompt
  // "Focus on this step now: X" sounded conversational and the model
  // would reply with "Sure, I'll do X" without ever calling a tool,
  // then the loop would advance and burn another step doing nothing.
  void planText;
  const stepNudge =
    `STEP ${stepIndex + 1}/${allSteps.length}: ${step}\n\n` +
    `Use the available tools to do this step now. Do not summarize, do ` +
    `not explain what you will do — just call the tools. When the step is ` +
    `concretely done, reply with one short line of confirmation and stop. ` +
    `If you cannot make progress with tools, say exactly what's blocking ` +
    `you in one sentence and stop.`;

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
      type: 'loop_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: PLAN_EXECUTE_LOOP_NAME,
      iteration,
    });

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

    const { text, toolUses, stopReason } = await collectProviderStream(ctx, messages, {
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
    const newCallsThisIteration = toolUses.filter((t) => {
      const sig = `${t.name}::${JSON.stringify(t.input ?? null)}`;
      return !callSignatures.has(sig);
    });
    if (newCallsThisIteration.length === 0) {
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
      // Record the signature so the NEXT iteration can detect a repeat.
      const sig = `${t.name}::${JSON.stringify(t.input ?? null)}`;
      callSignatures.add(sig);

      // Emit the request RIGHT BEFORE we dispatch + execute it so
      // every tool_call_requested in the log has a matching outcome.
      await ctx.emit({
        type: 'tool_call_requested',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        callId: asToolCallId(t.id),
        name: t.name,
        input: t.input,
      });

      // Run plugin onToolCall hooks first — this used to be skipped here
      // (a divergence from loop-tool-use that silently disabled plugin
      // gating for plan-execute). A hook may deny or rewrite the input.
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
      if (verdict.action === 'deny') {
        const reason = verdict.reason ?? 'denied by hook';
        await ctx.emit({
          type: 'tool_call_denied',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          callId: asToolCallId(t.id),
          decidedBy: 'hook',
          reason,
        });
        await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId: asToolCallId(t.id),
          ok: false,
          error: { kind: 'denied', message: reason },
        });
        continue;
      }

      const decision = await ctx.permissions.check(
        { callId: asToolCallId(t.id), name: t.name, input: actualInput },
        { sessionId: String(ctx.sessionId), toolDescription: ctx.tools.get(t.name)?.description },
      );
      if (decision.mode === 'deny') {
        await ctx.emit({
          type: 'tool_call_denied',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          callId: asToolCallId(t.id),
          decidedBy: 'resolver',
          reason: decision.reason ?? 'denied',
        });
        await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId: asToolCallId(t.id),
          ok: false,
          error: { kind: 'denied', message: decision.reason ?? 'denied' },
        });
        continue;
      }
      await ctx.emit({
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
        await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId: asToolCallId(t.id),
          ok: true,
          output,
        });
      } catch (err) {
        await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId: asToolCallId(t.id),
          ok: false,
          error: {
            kind: ctx.signal.aborted ? 'aborted' : 'threw',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }
  return false;
}

/**
 * Slim baseline used only by the planning phase (`collectPlan`): just the
 * raw user prompts, no assistant/tool history. The execute phase uses the
 * shared `projectMessagesFromLog` from the SDK instead.
 */
function buildBaseMessages(ctx: LoopContext): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const e of ctx.log.slice()) {
    if (e.type === 'user_prompt') {
      out.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    }
  }
  return out;
}

export function parsePlan(text: string): string[] {
  const lines = text.split('\n');
  const steps: string[] = [];
  let inPlan = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^plan\s*:?$/i.test(line)) {
      inPlan = true;
      continue;
    }
    const m = /^(?:\d+[.)]|[-*•])\s*(.+)$/.exec(line);
    if (m) {
      steps.push(m[1]!.trim());
      inPlan = true;
    } else if (inPlan && steps.length > 0 && !/^[A-Z]/.test(line)) {
      // continuation indented under previous step — skip
    }
  }
  return steps;
}
