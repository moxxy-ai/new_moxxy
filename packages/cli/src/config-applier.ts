import type { Session } from '@moxxy/core';
import type { ConfigApplier, ConfigApplyResult, MoxxyConfig } from '@moxxy/config';

/**
 * Build a ConfigApplier closed over a live Session. The applier diffs the new
 * config snapshot against its own cached "last applied" config and reflects
 * the safe subset onto the session immediately. Unsafe changes are reported
 * in `pending` so the agent (or user) knows a restart is needed.
 *
 * Safe (live): loop, compactor, model defaults (read per-turn anyway).
 * Pending (next boot): provider switch / apiKey, plugin enable/disable,
 *   channels.*, embeddings.*, skills paths, permissions.
 */
export function buildSessionConfigApplier(
  session: Session,
  initial: MoxxyConfig,
): ConfigApplier {
  let last: MoxxyConfig = initial;
  return async (next): Promise<ConfigApplyResult> => {
    const applied: string[] = [];
    const pending: string[] = [];

    if (next.loop !== last.loop) {
      try {
        if (next.loop) session.loops.setActive(next.loop);
        applied.push('loop');
      } catch (err) {
        pending.push(`loop (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (next.compactor !== last.compactor) {
      try {
        if (next.compactor) session.compactors.setActive(next.compactor);
        applied.push('compactor');
      } catch (err) {
        pending.push(`compactor (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (next.hookTimeoutMs !== last.hookTimeoutMs) {
      // The dispatcher reads timeout per call, but the cached value is set at
      // construction. For v0, report as pending.
      pending.push('hookTimeoutMs (restart required)');
    }

    // Provider changes can't be applied safely without re-resolving keys.
    if (providerChanged(last, next)) pending.push('provider.* (restart required)');

    // Plugin enable/disable would require dynamic register/unregister of every
    // contribution. v0: pending.
    if (pluginsChanged(last, next)) pending.push('plugins.*.enabled (restart required)');

    if (!shallowEqual(last.embeddings, next.embeddings)) {
      pending.push('embeddings.* (restart required to rebuild memory embedder)');
    }
    if (!shallowEqual(last.channels, next.channels)) {
      pending.push('channels.* (applies on next `moxxy <channel>` invocation)');
    }
    if (!shallowEqual(last.skills, next.skills)) {
      pending.push('skills.* (restart to rediscover)');
    }
    if (!shallowEqual(last.permissions, next.permissions)) {
      pending.push('permissions.* (restart to reload policy)');
    }

    last = next;
    return { applied, pending };
  };
}

function providerChanged(a: MoxxyConfig, b: MoxxyConfig): boolean {
  if (a.provider?.name !== b.provider?.name) return true;
  if (a.provider?.model !== b.provider?.model) return true;
  if (!shallowEqual(a.provider?.config, b.provider?.config)) return true;
  if (!arraysEqual(a.provider?.fallbacks, b.provider?.fallbacks)) return true;
  return false;
}

function pluginsChanged(a: MoxxyConfig, b: MoxxyConfig): boolean {
  const aKeys = Object.keys(a.plugins ?? {});
  const bKeys = Object.keys(b.plugins ?? {});
  if (aKeys.length !== bKeys.length) return true;
  for (const k of aKeys) {
    if (a.plugins?.[k]?.enabled !== b.plugins?.[k]?.enabled) return true;
  }
  return false;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

function arraysEqual<T>(a: ReadonlyArray<T> | undefined, b: ReadonlyArray<T> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
