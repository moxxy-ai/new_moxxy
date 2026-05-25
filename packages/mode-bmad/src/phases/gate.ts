import {
  type ApprovalDecision,
  type ModeContext,
  type MoxxyEvent,
} from '@moxxy/sdk';

import { MAX_REDRAFTS_PER_PHASE, type Artifacts, type PhaseSpec } from '../constants.js';
import { collectPhase } from './collect.js';

/**
 * Run a phase: collect a draft, then (optionally) gate it through the
 * user. The model + user can iterate via redraft until the cap is hit.
 *
 * Returns the approved artifact text, or `null` when the user/abort
 * cancels the turn (abort event already emitted on the generator).
 */
export async function* runPhaseWithGate(
  ctx: ModeContext,
  phase: PhaseSpec,
  artifactsSoFar: Artifacts,
): AsyncGenerator<MoxxyEvent, string | null, unknown> {
  let redraftFeedback: string | null = null;
  let redraftCount = 0;

  while (true) {
    if (ctx.signal.aborted) {
      yield await ctx.emit({
        type: 'abort',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        source: 'system',
        reason: `aborted during ${phase.id}`,
      });
      return null;
    }

    const text = await collectPhase(ctx, phase, artifactsSoFar, redraftFeedback);
    if (text === null) return null;

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
      yield await ctx.emit({
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
        yield await ctx.emit({
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
