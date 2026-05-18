/**
 * BMAD loop — Breakthrough Method for Agile AI-Driven Development.
 *
 * Drives a single user request through four sequential phases, each owned
 * by a different persona, with the artifact from each phase becoming the
 * input context for the next:
 *
 *   1. Analysis     — Analyst         → one-page PRD-style brief
 *   2. Planning     — Product Manager → numbered stories with acceptance criteria
 *   3. Solutioning  — Architect       → short design + change list
 *   4. Implementation — Developer     → tool-use sub-loop per story
 *
 * Between phases, an optional approval gate lets the user
 * approve / redraft / cancel. Without a resolver (headless / non-TTY) the
 * loop proceeds end-to-end.
 *
 * Inspired by https://github.com/bmad-code-org/BMAD-METHOD — the structured
 * persona handoffs are what makes this work for ambiguous, multi-step
 * requests where plan-execute under-specifies.
 */

import {
  asPluginId,
  asToolCallId,
  buildSystemPromptWithSkills,
  collectProviderStream,
  defineLoopStrategy,
  definePlugin,
  type ApprovalDecision,
  type LoopContext,
  type MoxxyEvent,
  type ProviderMessage,
} from '@moxxy/sdk';

export const BMAD_LOOP_NAME = 'bmad';

const BMAD_PLUGIN_ID = asPluginId('@moxxy/loop-bmad');

/** Maximum redraft cycles allowed per phase before the loop bails. */
const MAX_REDRAFTS_PER_PHASE = 3;
/** Refuse to execute plans with more stories than this — guards against runaways. */
const MAX_STORIES = 12;

type PhaseId = 'analysis' | 'planning' | 'solutioning';

interface PhaseSpec {
  readonly id: PhaseId;
  readonly title: string;
  readonly persona: string;
  readonly system: string;
  readonly approvalTitle: string;
  readonly approvalKind: string;
  /** Max output tokens for the artifact — phases are short by design. */
  readonly maxTokens: number;
}

const PHASES: ReadonlyArray<PhaseSpec> = [
  {
    id: 'analysis',
    title: 'Analysis',
    persona: 'Analyst',
    system: `You are the BMAD Analyst. Capture the problem the user wants solved.

Produce a ONE-PAGE brief with EXACTLY these headings, in this order:

## Problem
<one paragraph stating the user's actual goal>

## Constraints
- <bulleted list of constraints, assumptions, or non-goals>

## Success criteria
- <bulleted list of concrete, observable outcomes>

Keep it tight. No code, no implementation hints. Stop after the last bullet.`,
    approvalTitle: 'Analysis brief ready — review before planning',
    approvalKind: 'bmad.analysis',
    maxTokens: 800,
  },
  {
    id: 'planning',
    title: 'Planning',
    persona: 'Product Manager',
    system: `You are the BMAD Product Manager. Given the analyst's brief, decompose
the work into focused user stories.

Produce EXACTLY:

STORIES:
1. <short story title> — <one-line acceptance criterion>
2. <short story title> — <one-line acceptance criterion>
...

Limit yourself to between 1 and ${MAX_STORIES} stories. Each story should
be small enough that a developer can finish it in one focused tool-use
session. Do not write code. Stop after the last story.`,
    approvalTitle: 'Story list ready — review before solutioning',
    approvalKind: 'bmad.planning',
    maxTokens: 800,
  },
  {
    id: 'solutioning',
    title: 'Solutioning',
    persona: 'Architect',
    system: `You are the BMAD Architect. Given the brief and stories, produce a
minimal implementation design.

Produce EXACTLY:

## Approach
<one paragraph describing the overall approach>

## Touchpoints
- <file or module that changes, and why — one bullet each>

## Risks
- <bulleted list of risks or things to watch out for>

Keep it short. The developer phase will use the touchpoints as guidance.`,
    approvalTitle: 'Design ready — review before implementation',
    approvalKind: 'bmad.solutioning',
    maxTokens: 800,
  },
];

export const bmadLoop = defineLoopStrategy({
  name: BMAD_LOOP_NAME,
  run: runBmadLoop,
});

export const bmadLoopPlugin = definePlugin({
  name: '@moxxy/loop-bmad',
  version: '0.0.0',
  loopStrategies: [bmadLoop],
});

export default bmadLoopPlugin;

interface Artifacts {
  analysis: string;
  planning: string;
  stories: ReadonlyArray<string>;
  solutioning: string;
}

async function* runBmadLoop(ctx: LoopContext): AsyncIterable<MoxxyEvent> {
  if (ctx.signal.aborted) {
    yield await ctx.emit({
      type: 'abort',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      reason: 'aborted before BMAD start',
    });
    return;
  }

  yield await ctx.emit({
    type: 'loop_iteration',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    strategy: BMAD_LOOP_NAME,
    iteration: 0,
    routing: 'unresolved',
  });

  const artifacts: Artifacts = { analysis: '', planning: '', stories: [], solutioning: '' };

  // ----- Phases 1-3: produce, optionally approve, optionally redraft -----
  for (const phase of PHASES) {
    if (ctx.signal.aborted) {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: `aborted during ${phase.id}`,
      });
      return;
    }

    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: BMAD_PLUGIN_ID,
      subtype: 'bmad_phase_started',
      payload: { phase: phase.id, persona: phase.persona },
    });

    const text = await runPhaseWithGate(ctx, phase, artifacts);
    if (text === null) return; // aborted / cancelled — abort already emitted

    if (phase.id === 'analysis') artifacts.analysis = text;
    else if (phase.id === 'planning') {
      artifacts.planning = text;
      artifacts.stories = parseStories(text);
      if (artifacts.stories.length === 0) {
        yield await ctx.emit({
          type: 'error',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          kind: 'fatal',
          message:
            'bmad: planning produced no parseable stories — switch to a different loop strategy or rephrase the request.',
        });
        return;
      }
      if (artifacts.stories.length > MAX_STORIES) {
        yield await ctx.emit({
          type: 'error',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          kind: 'fatal',
          message: `bmad: planning produced ${artifacts.stories.length} stories (cap is ${MAX_STORIES}). Narrow the scope or switch loops.`,
        });
        return;
      }
    } else if (phase.id === 'solutioning') {
      artifacts.solutioning = text;
    }

    yield await ctx.emit({
      type: 'plugin_event',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'plugin',
      pluginId: BMAD_PLUGIN_ID,
      subtype: 'bmad_phase_completed',
      payload: { phase: phase.id, persona: phase.persona, artifact: text },
    });

    // Materialize the artifact as an assistant_message so subsequent
    // projection (used by the implementation phase) picks it up.
    yield await ctx.emit({
      type: 'assistant_message',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'model',
      content: text,
      stopReason: 'end_turn',
    });
  }

  // ----- Phase 4: implementation — hand off to a standard tool-use loop -----
  //
  // The first three BMAD phases load the conversation with rich context
  // (analyst brief + story list + architect design). For implementation we
  // intentionally drop the persona-driven gating and run a normal,
  // iteration-bounded tool-use loop so the developer can flow across
  // stories naturally — same engine that powers `tool-use`, just with the
  // BMAD artifacts in scope.
  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: BMAD_PLUGIN_ID,
    subtype: 'bmad_phase_started',
    payload: { phase: 'implementation', persona: 'Developer' },
  });

  // Visible banner so the user sees the auto-transition land in chat —
  // without this the only signal is the plugin_event above, which the TUI
  // doesn't render, and a silent first-iteration end_turn looks like the
  // turn just stopped.
  yield await ctx.emit({
    type: 'assistant_message',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    content:
      `→ Implementation phase: working through ${artifacts.stories.length} ` +
      `${artifacts.stories.length === 1 ? 'story' : 'stories'} as the developer persona.`,
    stopReason: 'end_turn',
  });

  const completed = yield* runImplementationLoop(ctx, artifacts);
  if (!completed) return; // abort/error already emitted

  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: BMAD_PLUGIN_ID,
    subtype: 'bmad_phase_completed',
    payload: { phase: 'implementation', persona: 'Developer', stories: artifacts.stories.length },
  });
}

/** Run a phase + (optionally) gate it through the user. Returns the
 *  approved artifact text, or null when the user/abort cancels the turn. */
async function runPhaseWithGate(
  ctx: LoopContext,
  phase: PhaseSpec,
  artifactsSoFar: Artifacts,
): Promise<string | null> {
  let text = '';
  let redraftFeedback: string | null = null;
  let redraftCount = 0;

  while (true) {
    if (ctx.signal.aborted) {
      await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: `aborted during ${phase.id}`,
      });
      return null;
    }

    const collected = await collectPhase(ctx, phase, artifactsSoFar, redraftFeedback);
    if (collected === null) return null;
    text = collected;

    if (!ctx.approval) return text; // headless — accept first draft

    const decision = await ctx.approval.confirm({
      title: phase.approvalTitle,
      body: text,
      kind: phase.approvalKind,
      defaultOptionId: 'approve',
      options: [
        {
          id: 'approve',
          label: 'Approve and continue',
          hotkey: 'a',
          description: `Move on to the next BMAD phase.`,
        },
        {
          id: 'redraft',
          label: 'Redraft with feedback',
          hotkey: 'r',
          requestsText: true,
          textPrompt: `What should change about the ${phase.id} output?`,
          description: 'Send feedback to the persona and get a new draft.',
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
      await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'user',
        reason: `${phase.id} rejected by user`,
      });
      return null;
    }
    if (decision.optionId === 'redraft') {
      redraftCount += 1;
      if (redraftCount > MAX_REDRAFTS_PER_PHASE) {
        await ctx.emit({
          type: 'error',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          kind: 'fatal',
          message: `bmad: ${phase.id} redrafted ${MAX_REDRAFTS_PER_PHASE}× without approval; aborting.`,
        });
        return null;
      }
      redraftFeedback = pickRedraftText(decision);
      continue;
    }
    return text; // approve
  }
}

function pickRedraftText(decision: ApprovalDecision): string {
  return decision.text?.trim() ?? '';
}

async function collectPhase(
  ctx: LoopContext,
  phase: PhaseSpec,
  artifactsSoFar: Artifacts,
  redraftFeedback: string | null,
): Promise<string | null> {
  const userMessages = buildBaseMessages(ctx);

  // Inject upstream artifacts (analysis + planning when in solutioning, etc.)
  // as a system-of-record block. We use a synthetic user turn rather than a
  // second system message because providers handle multi-system inputs
  // inconsistently.
  const upstream = upstreamContext(phase.id, artifactsSoFar);
  if (upstream) {
    userMessages.push({
      role: 'user',
      content: [{ type: 'text', text: upstream }],
    });
  }

  if (redraftFeedback) {
    userMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `The previous ${phase.id} draft needs to be redone. Feedback from the user: ${redraftFeedback}\n\n` +
            `Produce a new ${phase.title} output addressing this feedback.`,
        },
      ],
    });
  }

  const systemWithSkills = buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? '';
  const messages: ProviderMessage[] = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: phase.system + (systemWithSkills ? `\n\n${systemWithSkills}` : ''),
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
      messages,
      maxTokens: phase.maxTokens,
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

function upstreamContext(phaseId: PhaseId, artifacts: Artifacts): string | null {
  const parts: string[] = [];
  if (phaseId === 'planning' || phaseId === 'solutioning') {
    if (artifacts.analysis) parts.push(`## Analyst brief\n${artifacts.analysis}`);
  }
  if (phaseId === 'solutioning') {
    if (artifacts.planning) parts.push(`## Story list\n${artifacts.planning}`);
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

/**
 * Implementation phase = a standard tool-use loop with the developer
 * persona driving execution against the artifacts already in the log
 * (analyst brief, story list, architect design). One continuous loop —
 * the model flows across stories naturally rather than being herded
 * story-by-story. Returns `false` when an abort/error has already been
 * emitted by this generator; the caller should `return` immediately in
 * that case.
 */
async function* runImplementationLoop(
  ctx: LoopContext,
  artifacts: Artifacts,
): AsyncGenerator<MoxxyEvent, boolean, unknown> {
  const maxIterations = ctx.maxIterations ?? 50;

  const storyList = artifacts.stories
    .map((s, i) => `  ${i + 1}. [ ] ${s}`)
    .join('\n');
  // Single context block instead of three consecutive assistant messages.
  // Several providers (including codex /responses) handle alternating
  // user/assistant turns much better than 3+ consecutive assistant blocks
  // — the latter was making the codex implementation phase return
  // end_turn with empty text on iteration 1, which the loop was
  // mis-reading as "story complete" and exiting silently.
  const bmadContext =
    `BMAD context — three prior phases produced these artifacts:\n\n` +
    `## Analyst brief\n${artifacts.analysis}\n\n` +
    `## Story list\n${artifacts.planning}\n\n` +
    `## Architect's design\n${artifacts.solutioning}`;
  const devNudge =
    `Developer persona. Implement the stories above now using the available ` +
    `tools. Work through them in order; flow between stories as needed. ` +
    `Do not narrate — call the tools. When all acceptance criteria are met, ` +
    `reply with one short summary line and stop.\n\n` +
    `Stories to implement:\n${storyList}`;

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
      type: 'loop_iteration',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      strategy: BMAD_LOOP_NAME,
      iteration,
    });

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

    // Gate on toolUses, NOT stopReason. Some providers (codex) under-report
    // stop_reason='tool_use', so keying on stopReason would silently skip
    // tool execution. If there are tools to run, run them; otherwise wrap
    // up the phase.
    if (toolUses.length === 0) {
      // First-iteration silent end_turn is the bug signature that used to
      // make the implementation phase look like it never ran. Surface it
      // as a hint instead of pretending the work is done.
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
      const callId = asToolCallId(t.id);
      yield await ctx.emit({
        type: 'tool_call_requested',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'model',
        callId,
        name: t.name,
        input: t.input,
      });

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
        yield await ctx.emit({
          type: 'tool_call_denied',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          callId,
          decidedBy: 'hook',
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
        continue;
      }

      const decision = await ctx.permissions.check(
        { callId, name: t.name, input: actualInput },
        { sessionId: String(ctx.sessionId), toolDescription: ctx.tools.get(t.name)?.description },
      );
      if (decision.mode === 'deny') {
        yield await ctx.emit({
          type: 'tool_call_denied',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'system',
          callId,
          decidedBy: 'resolver',
          reason: decision.reason ?? 'denied',
        });
        yield await ctx.emit({
          type: 'tool_result',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'tool',
          callId,
          ok: false,
          error: { kind: 'denied', message: decision.reason ?? 'denied' },
        });
        continue;
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
  }
  // Iteration cap reached — treat as completed so the outer phase
  // wrapper still emits `bmad_phase_completed`. The model may not have
  // finished every story; that's expected when the user request is large.
  return true;
}

/** Just the user prompts from the log — used by every phase as the bottom
 *  layer; upstream artifacts and redraft feedback get layered on top. */
function buildBaseMessages(ctx: LoopContext): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const e of ctx.log.slice()) {
    if (e.type === 'user_prompt') {
      out.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    }
  }
  return out;
}

/**
 * Message builder for the implementation phase. Instead of replaying every
 * `assistant_message` from the log (which produces three consecutive
 * assistant turns and confuses providers like codex /responses), we
 * collapse the BMAD artifacts into a single context-bearing user message
 * before the developer nudge. The resulting shape on iteration 1 is:
 *
 *   system   = systemPrompt + skill index
 *   user[0]  = original prompt + tool_result blocks from the live log
 *   user[1]  = BMAD context (analyst brief, stories, design)
 *   user[2]  = developer nudge ("implement these now, use tools")
 *
 * On subsequent iterations only the live conversation (with whatever
 * tool calls and results the developer has produced) is replayed,
 * because the context block is already established in the conversation
 * via iteration 1.
 */
function buildImplementationMessages(
  ctx: LoopContext,
  bmadContext: string | null,
  devNudge: string | null,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const systemText =
    buildSystemPromptWithSkills(ctx.systemPrompt, ctx.skills.list()) ?? ctx.systemPrompt;
  if (systemText) {
    messages.push({ role: 'system', content: [{ type: 'text', text: systemText }] });
  }

  // Replay the live tool-use trace: user_prompt + (assistant tool_use /
  // tool_result) chains the developer has produced since the BMAD
  // artifacts. Pure assistant_message events from the artifact phases
  // are intentionally skipped — those go into the BMAD context block
  // instead so the provider sees alternating user/assistant turns.
  let pendingAssistant:
    | { role: 'assistant'; content: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> }
    | null = null;
  const flushAssistant = (): void => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };
  for (const e of ctx.log.slice()) {
    if (e.type === 'user_prompt') {
      flushAssistant();
      messages.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    } else if (e.type === 'tool_call_requested') {
      if (!pendingAssistant) pendingAssistant = { role: 'assistant', content: [] };
      pendingAssistant.content.push({
        type: 'tool_use',
        id: String(e.callId),
        name: e.name,
        input: e.input,
      });
    } else if (e.type === 'tool_result') {
      flushAssistant();
      const text = e.error
        ? `[error:${e.error.kind}] ${e.error.message}`
        : typeof e.output === 'string'
          ? e.output
          : JSON.stringify(e.output ?? '');
      messages.push({
        role: 'tool_result',
        content: [{ type: 'tool_result', toolUseId: String(e.callId), content: text, isError: !e.ok }],
      });
    }
  }
  flushAssistant();

  // Inject the BMAD context + dev nudge as standalone user turns on the
  // first iteration so the model has clean alternation.
  if (bmadContext) {
    messages.push({ role: 'user', content: [{ type: 'text', text: bmadContext }] });
  }
  if (devNudge) {
    messages.push({ role: 'user', content: [{ type: 'text', text: devNudge }] });
  }
  return messages;
}

/**
 * Parse the planning-phase output into individual story strings. Same
 * tolerance as plan-execute's parser: accepts `STORIES:` / `STORIES`
 * (optional colon) followed by numbered (`1.`, `2)`), dashed, or bulleted
 * lines. Returns the part after the marker character so `1. Foo — bar`
 * yields `"Foo — bar"`.
 */
export function parseStories(text: string): string[] {
  const lines = text.split('\n');
  const stories: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^stories\s*:?$/i.test(line)) {
      inBlock = true;
      continue;
    }
    const m = /^(?:\d+[.)]|[-*•])\s*(.+)$/.exec(line);
    if (m) {
      stories.push(m[1]!.trim());
      inBlock = true;
    } else if (inBlock && stories.length > 0 && !/^[A-Z]/.test(line)) {
      // continuation indented under previous story — skip
    }
  }
  return stories;
}
