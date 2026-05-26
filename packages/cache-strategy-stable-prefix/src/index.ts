import {
  defineCacheStrategy,
  definePlugin,
  type CacheHint,
  type CacheStrategyContext,
  type CacheStrategyDef,
  type ProviderMessage,
} from '@moxxy/sdk';

/**
 * Default prompt-cache strategy. Places up to 4 Anthropic breakpoints:
 *
 *  1. end of the tools array        — static for the whole session
 *  2. end of the system prompt      — static given a stable skill set
 *  3. end of the stable prefix      — the elision/compaction boundary, when
 *                                     the mode reports one (`stablePrefixMessageIndex`);
 *                                     a long-lived breakpoint that survives across turns
 *  4. end of the last message       — the rolling tail, so each inner iteration of a
 *                                     turn reads everything prior from cache and only
 *                                     pays full price for its own new delta
 *
 * The decisive correctness property is determinism: every breakpoint is a
 * pure function of the (append-only) message list, so the cached prefix stays
 * byte-identical across the iterations of a turn and the cache actually hits.
 */
export function createStablePrefixCacheStrategy(): CacheStrategyDef {
  return defineCacheStrategy({
    name: 'stable-prefix',
    plan(messages: ReadonlyArray<ProviderMessage>, ctx: CacheStrategyContext): ReadonlyArray<CacheHint> {
      const hints: CacheHint[] = [{ target: 'tools' }, { target: 'system' }];

      const lastIdx = lastNonSystemIndex(messages);
      if (lastIdx < 0) return hints; // nothing but a system prompt yet

      // Long-lived breakpoint at the stable prefix boundary (e.g. the elision
      // high-water mark). Only when it is strictly before the tail — otherwise
      // the tail breakpoint already covers it.
      const stableIdx = ctx.stablePrefixMessageIndex;
      if (stableIdx != null && stableIdx >= 0 && stableIdx < lastIdx) {
        hints.push({ target: { messageIndex: stableIdx } });
      }

      // Rolling tail breakpoint.
      hints.push({ target: { messageIndex: lastIdx } });

      return hints; // ≤ 4, Anthropic's limit
    },
  });
}

function lastNonSystemIndex(messages: ReadonlyArray<ProviderMessage>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'system') return i;
  }
  return -1;
}

/** Opt-out strategy: emits no breakpoints. Selected when caching is disabled. */
export function createNoCacheStrategy(): CacheStrategyDef {
  return defineCacheStrategy({ name: 'none', plan: () => [] });
}

export const stablePrefixCacheStrategyPlugin = definePlugin({
  name: '@moxxy/cache-strategy-stable-prefix',
  version: '0.0.0',
  // First entry auto-activates → caching on by default. `none` is the opt-out.
  cacheStrategies: [createStablePrefixCacheStrategy(), createNoCacheStrategy()],
});

export default stablePrefixCacheStrategyPlugin;
