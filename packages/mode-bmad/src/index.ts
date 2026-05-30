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
  defineMode,
  definePlugin,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

import {
  BMAD_MODE_NAME,
  BMAD_PLUGIN_ID,
  MAX_STORIES,
  type Artifacts,
  type PhaseSpec,
} from './constants.js';
import { parseStories } from './parse-stories.js';
import { runPhaseWithGate } from './phases/gate.js';
import { runImplementationLoop } from './phases/implementation.js';
import { PHASES } from './phases/specs.js';

export { BMAD_MODE_NAME } from './constants.js';
export { parseStories } from './parse-stories.js';

export const bmadMode = defineMode({
  name: BMAD_MODE_NAME,
  description: 'Five-phase product loop: brief, market, architect, design, develop — gated per phase',
  run: runBmadMode,
});

export const bmadModePlugin = definePlugin({
  name: '@moxxy/mode-bmad',
  version: '0.0.0',
  modes: [bmadMode],
});

export default bmadModePlugin;

async function* runBmadMode(ctx: ModeContext): AsyncIterable<MoxxyEvent> {
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
    type: 'mode_iteration',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    strategy: BMAD_MODE_NAME,
    iteration: 0,
    routing: 'unresolved',
  });

  const artifacts: Artifacts = { analysis: '', planning: '', stories: [], solutioning: '' };

  for (const phase of PHASES) {
    const ok = yield* runArtifactPhase(ctx, phase, artifacts);
    if (!ok) return;
  }

  yield* runImplementationPhaseSection(ctx, artifacts);
}

/**
 * Run one of the three artifact-producing phases (analysis / planning /
 * solutioning): start event, gated phase, validation, completion event,
 * and an assistant_message that puts the artifact into the log. Returns
 * `false` when the phase aborted/failed (already-emitted error/abort).
 */
async function* runArtifactPhase(
  ctx: ModeContext,
  phase: PhaseSpec,
  artifacts: Artifacts,
): AsyncGenerator<MoxxyEvent, boolean, unknown> {
  if (ctx.signal.aborted) {
    yield await ctx.emit({
      type: 'abort',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      reason: `aborted during ${phase.id}`,
    });
    return false;
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

  const text = yield* runPhaseWithGate(ctx, phase, artifacts);
  if (text === null) return false; // aborted / cancelled — abort already emitted

  const stored = storeArtifact(phase, artifacts, text);
  if (stored.fatal) {
    yield await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: 'fatal',
      message: stored.message,
    });
    return false;
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
  return true;
}

type StoreResult = { fatal: false } | { fatal: true; message: string };

function storeArtifact(phase: PhaseSpec, artifacts: Artifacts, text: string): StoreResult {
  if (phase.id === 'analysis') {
    artifacts.analysis = text;
    return { fatal: false };
  }
  if (phase.id === 'planning') {
    artifacts.planning = text;
    artifacts.stories = parseStories(text);
    if (artifacts.stories.length === 0) {
      return {
        fatal: true,
        message:
          'bmad: planning produced no parseable stories — switch to a different mode or rephrase the request.',
      };
    }
    if (artifacts.stories.length > MAX_STORIES) {
      return {
        fatal: true,
        message: `bmad: planning produced ${artifacts.stories.length} stories (cap is ${MAX_STORIES}). Narrow the scope or switch modes.`,
      };
    }
    return { fatal: false };
  }
  // solutioning
  artifacts.solutioning = text;
  return { fatal: false };
}

/**
 * Phase 4: implementation — hand off to a standard tool-use loop. The
 * first three BMAD phases load the conversation with rich context. For
 * implementation we intentionally drop the persona-driven gating and run
 * a normal, iteration-bounded tool-use loop so the developer can flow
 * across stories naturally.
 */
async function* runImplementationPhaseSection(
  ctx: ModeContext,
  artifacts: Artifacts,
): AsyncGenerator<MoxxyEvent, void, unknown> {
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
  // without this the only signal is the plugin_event above, which the
  // TUI doesn't render, and a silent first-iteration end_turn looks
  // like the turn just stopped.
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
  if (!completed) return;

  yield await ctx.emit({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: BMAD_PLUGIN_ID,
    subtype: 'bmad_phase_completed',
    payload: { phase: 'implementation', persona: 'Developer', stories: artifacts.stories.length },
  });

  // The BMAD workflow is complete — hand control back to the normal tool-use
  // mode so the user's NEXT message isn't trapped re-running the workflow.
  // Applied by the runner after this turn drains (no-op if tool-use isn't
  // registered); the InfoChanged broadcast updates each channel's mode badge.
  ctx.requestModeSwitch?.('tool-use');
}
