import { describe, expect, it } from 'vitest';
import { mergeConfigs } from './merge.js';

describe('mergeConfigs', () => {
  it('returns empty for no inputs', () => {
    expect(mergeConfigs()).toEqual({});
  });

  it('passes through a single config unchanged', () => {
    const a = { provider: { name: 'anthropic', model: 'sonnet' } };
    expect(mergeConfigs(a)).toEqual(a);
  });

  it('later wins on scalar fields', () => {
    const a = { provider: { name: 'anthropic', model: 'haiku' } };
    const b = { provider: { name: 'anthropic', model: 'sonnet' } };
    expect(mergeConfigs(a, b).provider?.model).toBe('sonnet');
  });

  it('merges nested objects key-by-key', () => {
    const a = { plugins: { 'a': { enabled: true } } };
    const b = { plugins: { 'b': { enabled: false } } };
    expect(mergeConfigs(a, b).plugins).toEqual({
      a: { enabled: true },
      b: { enabled: false },
    });
  });

  it('skips undefined entries', () => {
    expect(mergeConfigs(undefined, { provider: { name: 'x' } }, undefined)).toEqual({
      provider: { name: 'x' },
    });
  });

  it('concatenates arrays rather than replacing', () => {
    const a = { permissions: { allow: [{ name: 'Read' }] } };
    const b = { permissions: { allow: [{ name: 'Edit' }] } };
    expect(mergeConfigs(a, b).permissions?.allow).toEqual([{ name: 'Read' }, { name: 'Edit' }]);
  });

  it('merges plugin-specific options deeply', () => {
    const a = { plugins: { p: { options: { a: 1, deep: { x: 1 } } } } };
    const b = { plugins: { p: { options: { b: 2, deep: { y: 2 } } } } };
    expect(mergeConfigs(a, b).plugins?.p?.options).toEqual({
      a: 1,
      b: 2,
      deep: { x: 1, y: 2 },
    });
  });
});
