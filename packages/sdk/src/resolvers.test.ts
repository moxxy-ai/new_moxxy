import { describe, it, expect } from 'vitest';
import { evaluateToolRule } from './resolvers.js';
import type { PendingToolCall, PermissionRule } from './permission.js';

function call(name: string, input: unknown = {}): PendingToolCall {
  return { callId: 'c1', name, input } as unknown as PendingToolCall;
}

describe('evaluateToolRule', () => {
  it('returns null when the tool declares no rule (defer to resolver)', () => {
    expect(evaluateToolRule(undefined, call('reload_skills'))).toBeNull();
  });

  it('allows a tool that declares action allow', () => {
    const rule: PermissionRule = { action: 'allow' };
    expect(evaluateToolRule(rule, call('reload_skills'))).toEqual({
      mode: 'allow',
      reason: 'tool-declared allow',
    });
  });

  it('denies a tool that declares action deny', () => {
    const rule: PermissionRule = { action: 'deny', reason: 'nope' };
    expect(evaluateToolRule(rule, call('danger'))).toEqual({ mode: 'deny', reason: 'nope' });
  });

  it('defers (null) for action prompt so the interactive resolver decides', () => {
    expect(evaluateToolRule({ action: 'prompt' }, call('self_update_verify'))).toBeNull();
  });

  it('only applies when the name pattern matches', () => {
    const rule: PermissionRule = { action: 'allow', pattern: { name: 'reload_skills' } };
    expect(evaluateToolRule(rule, call('reload_skills'))).not.toBeNull();
    expect(evaluateToolRule(rule, call('other_tool'))).toBeNull();
  });

  it('matches on inputMatches (string + RegExp)', () => {
    const rule: PermissionRule = {
      action: 'allow',
      pattern: { inputMatches: { path: /^\/tmp\// } },
    };
    expect(evaluateToolRule(rule, call('write', { path: '/tmp/ok.txt' }))).not.toBeNull();
    expect(evaluateToolRule(rule, call('write', { path: '/etc/passwd' }))).toBeNull();
  });
});
