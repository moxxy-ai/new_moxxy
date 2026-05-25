import type { ModeContext } from '@moxxy/sdk';

import { MAX_REDRAFTS } from './constants.js';

export type PlanGateOutcome =
  | { kind: 'approve' }
  | { kind: 'redraft'; feedback: string | null }
  | { kind: 'cancel' }
  | { kind: 'redraft-cap-exceeded' };

/**
 * Run the optional approval gate for the planning phase. Headless contexts
 * (no resolver) auto-approve. Returns the decision plus the new redraft
 * count when the user asked for a redraft.
 */
export async function runPlanApprovalGate(
  ctx: ModeContext,
  planText: string,
  stepCount: number,
  redraftCount: number,
): Promise<{ outcome: PlanGateOutcome; redraftCount: number }> {
  if (!ctx.approval) return { outcome: { kind: 'approve' }, redraftCount };

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
        description: `Execute the ${stepCount} step${stepCount === 1 ? '' : 's'} above.`,
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

  if (decision.optionId === 'cancel') return { outcome: { kind: 'cancel' }, redraftCount };
  if (decision.optionId === 'redraft') {
    const nextCount = redraftCount + 1;
    if (nextCount > MAX_REDRAFTS) {
      return { outcome: { kind: 'redraft-cap-exceeded' }, redraftCount: nextCount };
    }
    return {
      outcome: { kind: 'redraft', feedback: decision.text ?? null },
      redraftCount: nextCount,
    };
  }
  return { outcome: { kind: 'approve' }, redraftCount };
}
