import { describe, expect, it } from 'vitest';
import { chooseClientMode, collectExtraFlags } from './client-mode.js';
import type { ParsedArgv } from '../argv.js';

describe('chooseClientMode', () => {
  it('standalone always wins, regardless of a runner', () => {
    expect(chooseClientMode({ standalone: true, runnerUp: true })).toBe('standalone');
    expect(chooseClientMode({ standalone: true, runnerUp: false })).toBe('standalone');
  });

  it('attaches when a runner is up', () => {
    expect(chooseClientMode({ standalone: false, runnerUp: true })).toBe('attach');
  });

  it('self-hosts when no runner is up', () => {
    expect(chooseClientMode({ standalone: false, runnerUp: false })).toBe('self-host');
  });
});

describe('collectExtraFlags', () => {
  const argv = (flags: ParsedArgv['flags']): ParsedArgv => ({
    command: 'telegram',
    positional: [],
    flags,
  });

  it('drops the reserved launcher flags but keeps channel-specific ones', () => {
    expect(
      collectExtraFlags(
        argv({
          model: 'x',
          config: 'c',
          verbose: true,
          standalone: true,
          attach: true,
          pair: true,
          foo: 'bar',
        }),
      ),
    ).toEqual({ pair: true, foo: 'bar' });
  });

  it('returns empty when only reserved flags are present', () => {
    expect(collectExtraFlags(argv({ model: 'x', standalone: true }))).toEqual({});
  });
});
