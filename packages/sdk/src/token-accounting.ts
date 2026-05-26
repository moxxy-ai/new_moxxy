import type { MoxxyEvent, ProviderResponseEvent } from './events.js';
import type { EventLogReader } from './log.js';
import type { TokenUsage } from './provider.js';

/**
 * Token accounting derived from the event log. The single source of truth is
 * the stream of `provider_response` events (each carries the provider-reported
 * usage for one call); cumulative session totals are just a fold over them, so
 * there is no separate mutable counter to keep in sync.
 *
 * Anthropic usage semantics (which this models): `inputTokens` is the
 * NON-cached portion of the prompt; cache reads and cache writes are reported
 * separately and are NOT included in `inputTokens`. So the full prompt size of
 * a call is `input + cacheRead + cacheCreation`.
 */

// Relative price multipliers vs. an uncached input token (Anthropic ephemeral
// cache pricing). Kept here so the savings math is explicit and tweakable.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/** Partial `provider_response` fields for a given usage; `{}` when usage is absent. */
export function usageEventFields(usage?: TokenUsage): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} {
  if (!usage) return {};
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
  };
}

export interface SessionTokenSummary {
  /** Number of provider calls that reported usage. */
  readonly calls: number;
  /** Sum of non-cached input tokens (billed 1.0x). */
  readonly totalInput: number;
  /** Sum of cache-read tokens (billed 0.1x). */
  readonly totalCacheRead: number;
  /** Sum of cache-creation/write tokens (billed 1.25x). */
  readonly totalCacheCreation: number;
  /** Sum of output tokens. */
  readonly totalOutput: number;
  /** Total prompt tokens fed to the model across the session (input + reads + writes). */
  readonly totalPrompt: number;
  /** cacheRead / totalPrompt — fraction of prompt served from cache. */
  readonly cacheHitRate: number;
  /** Billed-equivalent input cost (read 0.1x + write 1.25x + plain 1.0x), in token units. */
  readonly billedInputEq: number;
  /** What the input would cost with no caching (every prompt token at 1.0x). */
  readonly uncachedInputEq: number;
  /** 1 - billedInputEq/uncachedInputEq — fraction of input cost saved by caching. */
  readonly savedRatio: number;
  /**
   * False only when caching is clearly broken: across enough calls the provider
   * is *writing* cache (cacheCreation > 0) but almost never *reading* it back —
   * the signature of an unstable prefix silently paying the 1.25x write tax.
   * True when caching works OR is simply off (no writes) — so this never
   * false-alarms a deliberately disabled cache.
   */
  readonly cacheEffective: boolean;
}

/** Fold `provider_response` events into cumulative per-session token totals. */
export function summarizeSessionTokens(log: EventLogReader): SessionTokenSummary {
  return foldResponses(log.ofType('provider_response'));
}

/**
 * Same as {@link summarizeSessionTokens} but over a raw event array — for
 * channels (e.g. the TUI) that hold the materialized event stream rather than
 * an `EventLogReader`.
 */
export function summarizeSessionTokensFromEvents(
  events: ReadonlyArray<MoxxyEvent>,
): SessionTokenSummary {
  return foldResponses(
    events.filter((e): e is ProviderResponseEvent => e.type === 'provider_response'),
  );
}

function foldResponses(responses: ReadonlyArray<ProviderResponseEvent>): SessionTokenSummary {
  let calls = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalOutput = 0;

  for (const e of responses) {
    // Count a call only when it reported any token data.
    if (
      e.inputTokens === undefined &&
      e.outputTokens === undefined &&
      e.cacheReadTokens === undefined &&
      e.cacheCreationTokens === undefined
    ) {
      continue;
    }
    calls += 1;
    totalInput += e.inputTokens ?? 0;
    totalCacheRead += e.cacheReadTokens ?? 0;
    totalCacheCreation += e.cacheCreationTokens ?? 0;
    totalOutput += e.outputTokens ?? 0;
  }

  const totalPrompt = totalInput + totalCacheRead + totalCacheCreation;
  const billedInputEq =
    totalInput + totalCacheRead * CACHE_READ_MULT + totalCacheCreation * CACHE_WRITE_MULT;
  const uncachedInputEq = totalPrompt;
  const cacheHitRate = totalPrompt > 0 ? totalCacheRead / totalPrompt : 0;
  return {
    calls,
    totalInput,
    totalCacheRead,
    totalCacheCreation,
    totalOutput,
    totalPrompt,
    cacheHitRate,
    billedInputEq,
    uncachedInputEq,
    savedRatio: uncachedInputEq > 0 ? 1 - billedInputEq / uncachedInputEq : 0,
    // Broken = writing cache but not reading it back, over enough calls.
    cacheEffective: !(calls >= 5 && totalCacheCreation > 0 && cacheHitRate < 0.05),
  };
}
