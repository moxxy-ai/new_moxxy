import type { EventLogReader } from './log.js';
import type { CacheHint, ProviderMessage } from './provider.js';

/**
 * Context handed to a CacheStrategy when it plans breakpoints for one call.
 */
export interface CacheStrategyContext {
  readonly model: string;
  /** Active model's context window, for strategies that scale behavior to it. */
  readonly contextWindow: number;
  readonly log: EventLogReader;
  /**
   * Index (into the `messages` array passed to `plan`) of the last message
   * belonging to the stable, cacheable prefix — everything at or before it is
   * byte-identical across the inner iterations of the current turn, so a
   * rolling breakpoint placed here yields cache reads on every iteration.
   * Undefined when the mode can't compute a boundary (e.g. no elision active);
   * strategies should then fall back to a conservative breakpoint.
   */
  readonly stablePrefixMessageIndex?: number;
}

/**
 * A swappable prompt-caching strategy. One is active per session (registered
 * via plugins, exactly like compactors/modes). It decides *where* cache
 * breakpoints go and returns provider-neutral {@link CacheHint}s; the provider
 * is responsible for *how* to express them (Anthropic → `cache_control`).
 *
 * `plan` MUST be deterministic given identical inputs — a non-deterministic
 * breakpoint placement shifts the cached prefix between calls and silently
 * defeats the cache (paying 1.25x writes for 0 reads).
 */
export interface CacheStrategyDef {
  readonly name: string;
  plan(
    messages: ReadonlyArray<ProviderMessage>,
    ctx: CacheStrategyContext,
  ): ReadonlyArray<CacheHint>;
}
