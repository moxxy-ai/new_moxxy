import { describe, it, expect } from 'vitest';
import { resolveFlow, type FlowStep } from './step-flow';

interface Ctx {
  full: boolean;
  cliInstalled: boolean;
  hasProvider: boolean;
}

const STEPS: ReadonlyArray<FlowStep<Ctx>> = [
  { id: 'welcome', label: 'Welcome', applies: (c) => c.full },
  { id: 'cli', label: 'CLI', applies: (c) => c.full || !c.cliInstalled, satisfied: (c) => c.cliInstalled },
  { id: 'provider', label: 'Provider', applies: (c) => c.full || !c.hasProvider, satisfied: (c) => c.hasProvider },
  { id: 'done', label: 'Done', applies: (c) => c.full },
];

describe('resolveFlow', () => {
  it('linear: shows every applicable step regardless of satisfied', () => {
    const ctx: Ctx = { full: true, cliInstalled: true, hasProvider: true };
    expect(resolveFlow(STEPS, ctx, 'linear', 0).steps.map((s) => s.id)).toEqual([
      'welcome',
      'cli',
      'provider',
      'done',
    ]);
    expect(resolveFlow(STEPS, ctx, 'linear', 0).currentId).toBe('welcome');
    expect(resolveFlow(STEPS, ctx, 'linear', 2).currentId).toBe('provider');
  });

  it('linear: completes when the cursor passes the last applicable step', () => {
    const ctx: Ctx = { full: true, cliInstalled: false, hasProvider: false };
    const r = resolveFlow(STEPS, ctx, 'linear', 4);
    expect(r.isComplete).toBe(true);
    expect(r.currentId).toBeNull();
  });

  it('auto: filters out non-applicable steps (recovery gate)', () => {
    // onboarding complete (full=false), CLI present, provider missing →
    // only the provider step applies.
    const ctx: Ctx = { full: false, cliInstalled: true, hasProvider: false };
    const r = resolveFlow(STEPS, ctx, 'auto', 0);
    expect(r.steps.map((s) => s.id)).toEqual(['provider']);
    expect(r.currentId).toBe('provider');
    expect(r.isComplete).toBe(false);
  });

  it('auto: current is the first applicable UNSATISFIED step', () => {
    const ctx: Ctx = { full: false, cliInstalled: false, hasProvider: false };
    const r = resolveFlow(STEPS, ctx, 'auto', 0);
    // both cli + provider apply; cli is first unsatisfied.
    expect(r.steps.map((s) => s.id)).toEqual(['cli', 'provider']);
    expect(r.currentId).toBe('cli');
  });

  it('auto: advances reactively as steps become satisfied', () => {
    const steps = STEPS;
    const afterCli: Ctx = { full: false, cliInstalled: true, hasProvider: false };
    expect(resolveFlow(steps, afterCli, 'auto', 0).currentId).toBe('provider');
    const allMet: Ctx = { full: false, cliInstalled: true, hasProvider: true };
    const r = resolveFlow(steps, allMet, 'auto', 0);
    expect(r.isComplete).toBe(true);
    expect(r.currentId).toBeNull();
  });

  it('completes when no steps apply', () => {
    const ctx: Ctx = { full: false, cliInstalled: true, hasProvider: true };
    expect(resolveFlow(STEPS, ctx, 'auto', 0).isComplete).toBe(true);
    expect(resolveFlow(STEPS, ctx, 'linear', 0).isComplete).toBe(true);
  });

  it('default applies/satisfied: a bare step always applies, never auto-satisfies', () => {
    const bare: ReadonlyArray<FlowStep<Ctx>> = [{ id: 'a', label: 'A' }];
    const ctx: Ctx = { full: false, cliInstalled: false, hasProvider: false };
    expect(resolveFlow(bare, ctx, 'auto', 0).currentId).toBe('a');
    expect(resolveFlow(bare, ctx, 'linear', 0).currentId).toBe('a');
  });
});
