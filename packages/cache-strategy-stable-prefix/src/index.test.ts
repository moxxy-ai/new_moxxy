import { describe, expect, it } from 'vitest';
import type { CacheStrategyContext, ProviderMessage } from '@moxxy/sdk';
import { createStablePrefixCacheStrategy, createNoCacheStrategy } from './index.js';

const strategy = createStablePrefixCacheStrategy();

const msgs: ProviderMessage[] = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'user', content: [{ type: 'text', text: 'a' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
  { role: 'user', content: [{ type: 'text', text: 'c' }] },
];

const ctx = (over: Partial<CacheStrategyContext> = {}): CacheStrategyContext => ({
  model: 'm',
  contextWindow: 200_000,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  ...over,
});

describe('stable-prefix cache strategy', () => {
  it('marks tools, system, and the rolling tail', () => {
    const hints = strategy.plan(msgs, ctx());
    expect(hints).toContainEqual({ target: 'tools' });
    expect(hints).toContainEqual({ target: 'system' });
    expect(hints).toContainEqual({ target: { messageIndex: 3 } }); // last non-system
  });

  it('adds a long-lived stable-prefix breakpoint when given one, within Anthropic 4-limit', () => {
    const hints = strategy.plan(msgs, ctx({ stablePrefixMessageIndex: 1 }));
    expect(hints).toContainEqual({ target: { messageIndex: 1 } });
    expect(hints).toContainEqual({ target: { messageIndex: 3 } });
    expect(hints.length).toBeLessThanOrEqual(4);
  });

  it('does not duplicate when the stable index equals the tail', () => {
    const hints = strategy.plan(msgs, ctx({ stablePrefixMessageIndex: 3 }));
    const msgHints = hints.filter((h) => typeof h.target === 'object');
    expect(msgHints).toHaveLength(1);
  });

  it('is deterministic', () => {
    expect(strategy.plan(msgs, ctx())).toEqual(strategy.plan(msgs, ctx()));
  });

  it('emits no message breakpoint when only a system prompt exists', () => {
    const hints = strategy.plan([msgs[0]!], ctx());
    expect(hints.every((h) => h.target === 'tools' || h.target === 'system')).toBe(true);
  });

  it('none strategy emits no breakpoints', () => {
    expect(createNoCacheStrategy().plan(msgs, ctx())).toEqual([]);
  });
});
