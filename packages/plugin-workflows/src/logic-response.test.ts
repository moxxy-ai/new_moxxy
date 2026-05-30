import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '@moxxy/sdk';
import {
  parseLogicResponse,
  resolveBranchForCondition,
  resolveBranchForSwitch,
  stepsToSkipForBranch,
  wantsPlainResponse,
} from './logic-response.js';

function step(partial: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return {
    needs: [],
    onError: 'fail',
    retries: 0,
    ...partial,
  };
}

describe('parseLogicResponse', () => {
  it('parses vars and branch from JSON', () => {
    const r = parseLogicResponse(
      '{"vars":{"email":"a@b.c"},"branch":"then","text":"ok"}',
      step({ id: 'x', bridge: 'x' }),
      'json',
    );
    expect(r.vars).toEqual({ email: 'a@b.c' });
    expect(r.branch).toBe('then');
    expect(r.output).toBe('ok');
  });

  it('strips markdown fences', () => {
    const r = parseLogicResponse(
      '```json\n{"vars":{"x":1}}\n```',
      step({ id: 'x', bridge: 'x' }),
      'json',
    );
    expect(r.vars).toEqual({ x: 1 });
  });

  it('returns plain output without parsing', () => {
    const r = parseLogicResponse('hello world', step({ id: 'x', bridge: 'x', format: 'plain' }), 'plain');
    expect(r.output).toBe('hello world');
    expect(r.vars).toBeUndefined();
  });
});

describe('branch routing helpers', () => {
  it('resolves condition branches', () => {
    const s = step({ id: 'g', condition: 'x', then: ['a'], else: ['b'] });
    expect(resolveBranchForCondition(s, 'then')).toBe('then');
    expect(resolveBranchForCondition(s, 'ELSE')).toBe('else');
    expect(resolveBranchForCondition(s, 'maybe')).toBeUndefined();
  });

  it('resolves switch branches and default', () => {
    const s = step({
      id: 'g',
      switch: 'x',
      cases: { pies: ['a'], kot: ['b'] },
      default: ['c'],
    });
    expect(resolveBranchForSwitch(s, 'kot')).toBe('kot');
    expect(resolveBranchForSwitch(s, 'unknown')).toBe('__default__');
  });

  it('computes steps to skip for condition', () => {
    const s = step({ id: 'g', condition: 'x', then: ['a'], else: ['b', 'c'] });
    expect(stepsToSkipForBranch(s, 'then')).toEqual(['b', 'c']);
    expect(stepsToSkipForBranch(s, 'else')).toEqual(['a']);
  });
});

describe('wantsPlainResponse', () => {
  it('honours format plain', () => {
    expect(wantsPlainResponse(step({ id: 'x', bridge: 'x', format: 'plain' }))).toBe(true);
  });
});
