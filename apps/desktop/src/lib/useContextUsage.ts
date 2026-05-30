import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SessionInfo } from '@moxxy/sdk';
import { api } from './api';
import { chatStore, EMPTY_USAGE, type UsageSnapshot } from './chatStore';

/**
 * Live context-window accounting for a workspace.
 *
 *   - `contextTokens` is the size of the **most recent** prompt the provider
 *     reported (`input + cacheRead + cacheCreation`) — exactly what occupies
 *     the model's window right now, so it's the honest "context used" number.
 *     It comes from {@link chatStore}'s usage accumulator, which folds
 *     `provider_response` events (those aren't rendered or persisted, so they
 *     never reach the display log — the accumulator is the only place the
 *     token counts live).
 *   - `contextWindow` comes from the active provider/model descriptor in
 *     `session.info` (fetched once per workspace/model), mirroring the TUI's
 *     `resolveContextWindow`. It's known as soon as the workspace connects —
 *     so the meter can render (at 0%) before the first reply.
 *   - `summary` is the cumulative per-session token accounting the usage
 *     modal renders.
 */

// Anthropic ephemeral-cache price multipliers vs. an uncached input token —
// kept in sync with `@moxxy/sdk`'s token-accounting so the savings math matches.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

export interface TokenSummary {
  readonly calls: number;
  readonly totalInput: number;
  readonly totalCacheRead: number;
  readonly totalCacheCreation: number;
  readonly totalOutput: number;
  /** input + cache read + cache write across the session. */
  readonly totalPrompt: number;
  /** cacheRead / totalPrompt. */
  readonly cacheHitRate: number;
  /** 1 − billedInputEq / uncachedInputEq — input cost saved by caching. */
  readonly savedRatio: number;
}

export interface ContextUsage {
  /** Tokens in the latest prompt sent to the model, or null before any call. */
  readonly contextTokens: number | null;
  /** Active model's context window, or null when unknown. */
  readonly contextWindow: number | null;
  /** (contextTokens ?? 0) / contextWindow in [0, 1], or null when the window
   *  is unknown. Defaults the numerator to 0 so the meter shows at 0% on a
   *  fresh connect rather than staying hidden. */
  readonly fraction: number | null;
  /** Cumulative per-session token accounting. */
  readonly summary: TokenSummary;
  /** Per-call prompt sizes in call order — feeds the growth sparkline. */
  readonly perCall: ReadonlyArray<number>;
  /** True once at least one provider response with usage has arrived. */
  readonly hasData: boolean;
}

function summarize(u: UsageSnapshot): TokenSummary {
  const totalPrompt = u.totalInput + u.totalCacheRead + u.totalCacheCreation;
  const billedInputEq =
    u.totalInput + u.totalCacheRead * CACHE_READ_MULT + u.totalCacheCreation * CACHE_WRITE_MULT;
  return {
    calls: u.calls,
    totalInput: u.totalInput,
    totalCacheRead: u.totalCacheRead,
    totalCacheCreation: u.totalCacheCreation,
    totalOutput: u.totalOutput,
    totalPrompt,
    cacheHitRate: totalPrompt > 0 ? u.totalCacheRead / totalPrompt : 0,
    savedRatio: totalPrompt > 0 ? 1 - billedInputEq / totalPrompt : 0,
  };
}

/** Mirror of the TUI's resolveContextWindow over a SessionInfo snapshot. */
function resolveContextWindow(info: SessionInfo | null, model: string | null): number | null {
  if (!info) return null;
  const provider =
    info.providers.find((p) => p.name === info.activeProvider) ?? info.providers[0];
  if (!provider) return null;
  const match = model ? provider.models.find((m) => m.id === model) : undefined;
  return match?.contextWindow ?? provider.models[0]?.contextWindow ?? null;
}

export function useContextUsage(workspaceId: string | null): ContextUsage {
  const usage = useSyncExternalStore(chatStore.subscribe, () =>
    workspaceId ? chatStore.getUsage(workspaceId) : EMPTY_USAGE,
  );
  const model = useSyncExternalStore(chatStore.subscribe, () =>
    workspaceId ? chatStore.getModel(workspaceId) : null,
  );

  // The context window is a property of the active provider/model, not the
  // log — fetch it once per (workspace, model). A provider switch resets the
  // sticky model, so keying on `model` also refetches after a provider change.
  const [info, setInfo] = useState<SessionInfo | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void api()
      .invoke('session.info', { workspaceId })
      .then((raw) => {
        if (!cancelled) setInfo(raw);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, model]);

  const summary = useMemo(() => summarize(usage), [usage]);
  const contextWindow = useMemo(() => resolveContextWindow(info, model), [info, model]);

  const fraction =
    contextWindow && contextWindow > 0
      ? Math.max(0, Math.min(1, (usage.latestPrompt ?? 0) / contextWindow))
      : null;

  return {
    contextTokens: usage.latestPrompt,
    contextWindow,
    fraction,
    summary,
    perCall: usage.perCall,
    hasData: usage.calls > 0,
  };
}
