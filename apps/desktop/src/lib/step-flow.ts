import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A small, reusable rules-driven stepper. A flow is a list of steps, each
 * with optional gate predicates over a caller-supplied context:
 *
 *   - `applies(ctx)`   — is this step part of the flow at all? Steps that
 *                        don't apply are filtered out entirely, so several
 *                        flows can be expressed as one step list with
 *                        different gates (e.g. full first-run onboarding vs
 *                        a "you're missing a prerequisite" recovery gate).
 *   - `satisfied(ctx)` — is the step's objective already met?
 *
 * Two navigation modes:
 *   - 'linear': a manual walk from the first applicable step; `next`/`back`
 *      drive it and the flow completes when you advance past the last step.
 *      `satisfied` is ignored (the user sees every step).
 *   - 'auto':   reactive; the current step is the first applicable step
 *      that isn't satisfied, and the flow completes once all applicable
 *      steps are satisfied. Used for gates that should resolve themselves
 *      as the underlying state changes.
 *
 * Nothing here is onboarding-specific — it's a generic gated stepper.
 */

export interface FlowStep<Ctx> {
  readonly id: string;
  readonly label: string;
  /** Part of the flow for this context? Defaults to always-applies. */
  readonly applies?: (ctx: Ctx) => boolean;
  /** Objective already met? Defaults to never-satisfied. */
  readonly satisfied?: (ctx: Ctx) => boolean;
}

export type FlowMode = 'linear' | 'auto';

export interface ResolvedFlow {
  /** The active steps (those whose `applies` held), in order. */
  readonly steps: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** Index of the current step within `steps`, or −1 when complete. */
  readonly index: number;
  /** Id of the current step, or null when complete. */
  readonly currentId: string | null;
  readonly isComplete: boolean;
}

/**
 * Pure resolution of a flow's current position — no React. Exposed so the
 * gating logic is unit-testable without rendering.
 */
export function resolveFlow<Ctx>(
  allSteps: ReadonlyArray<FlowStep<Ctx>>,
  ctx: Ctx,
  mode: FlowMode,
  cursor: number,
): ResolvedFlow {
  const active = allSteps.filter((s) => s.applies?.(ctx) ?? true);
  const steps = active.map((s) => ({ id: s.id, label: s.label }));
  const done: ResolvedFlow = { steps, index: -1, currentId: null, isComplete: true };
  if (active.length === 0) return done;

  if (mode === 'auto') {
    const firstUnmet = active.findIndex((s) => !(s.satisfied?.(ctx) ?? false));
    if (firstUnmet === -1) return done;
    return { steps, index: firstUnmet, currentId: active[firstUnmet]!.id, isComplete: false };
  }

  if (cursor >= active.length) return done;
  const index = Math.max(0, cursor);
  return { steps, index, currentId: active[index]!.id, isComplete: false };
}

export interface FlowController extends ResolvedFlow {
  readonly isFirst: boolean;
  readonly isLast: boolean;
  /** Advance to the next applicable step, or complete past the last. */
  readonly next: () => void;
  /** Go back one step (clamped at the first). */
  readonly back: () => void;
}

export function useStepFlow<Ctx>(
  allSteps: ReadonlyArray<FlowStep<Ctx>>,
  ctx: Ctx,
  opts: { readonly mode: FlowMode; readonly onComplete: () => void },
): FlowController {
  const [cursor, setCursor] = useState(0);
  const resolved = resolveFlow(allSteps, ctx, opts.mode, cursor);

  // Fire onComplete exactly once per completion edge.
  const completedRef = useRef(false);
  const onCompleteRef = useRef(opts.onComplete);
  onCompleteRef.current = opts.onComplete;
  useEffect(() => {
    if (resolved.isComplete && !completedRef.current) {
      completedRef.current = true;
      onCompleteRef.current();
    } else if (!resolved.isComplete) {
      completedRef.current = false;
    }
  }, [resolved.isComplete]);

  const next = useCallback(() => setCursor((c) => c + 1), []);
  const back = useCallback(() => setCursor((c) => Math.max(0, c - 1)), []);

  return {
    ...resolved,
    isFirst: resolved.index <= 0,
    isLast: resolved.index === resolved.steps.length - 1,
    next,
    back,
  };
}
