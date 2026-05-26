import { PluginRequirementError, readPackageMoxxyRequirements, type Session } from '@moxxy/core';
import type { MoxxyRequirement, Plugin } from '@moxxy/sdk';
import type { ConfigApplier, ConfigApplyResult, MoxxyConfig } from '@moxxy/config';

export interface BuiltinPluginEntry {
  readonly name: string;
  readonly plugin: Plugin;
}

interface BuiltinPluginRecord {
  readonly plugin: Plugin;
  /** Resolved lazily on first toggle from `<name>/package.json#moxxy.requirements`. */
  requirements?: ReadonlyArray<MoxxyRequirement>;
  requirementsLoaded: boolean;
}

/**
 * Build a ConfigApplier closed over a live Session. The applier diffs the new
 * config snapshot against its own cached "last applied" config and reflects
 * changes onto the session immediately where it can.
 *
 * Live (applied):
 *   mode, compactor, plugins[X].enabled (toggle register/unload).
 * Pending (next boot):
 *   provider.* (key rotation needs vault unlock + setActive)
 *   embeddings.* (memory plugin is built once)
 *   channels.*  (applies on next `moxxy <channel>` invocation)
 *   skills.*    (restart to rediscover)
 *   permissions.* (restart to reload policy)
 *
 * For plugin hot-toggling, the applier needs the original `{name, plugin}`
 * map that setupSession used so it can re-register a previously-disabled
 * plugin. Pass it in via the third arg.
 */
export function buildSessionConfigApplier(
  session: Session,
  initial: MoxxyConfig,
  builtins: ReadonlyArray<BuiltinPluginEntry> = [],
): ConfigApplier {
  let last: MoxxyConfig = initial;
  const builtinsByName = new Map<string, BuiltinPluginRecord>(
    builtins.map((b) => [b.name, { plugin: b.plugin, requirementsLoaded: false }] as const),
  );

  return async (next): Promise<ConfigApplyResult> => {
    const applied: string[] = [];
    const pending: string[] = [];

    if (next.mode !== last.mode) {
      try {
        if (next.mode) session.modes.setActive(next.mode);
        applied.push('mode');
      } catch (err) {
        pending.push(`mode (${err instanceof Error ? err.message : String(err)})`);
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

    if (
      next.context?.caching !== last.context?.caching ||
      next.context?.cacheStrategy !== last.context?.cacheStrategy
    ) {
      try {
        if (next.context?.caching === false) session.cacheStrategies.setActive('none');
        else session.cacheStrategies.setActive(next.context?.cacheStrategy ?? 'stable-prefix');
        applied.push('cacheStrategy');
      } catch (err) {
        pending.push(`cacheStrategy (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (next.context?.elision !== last.context?.elision) {
      session.elisionSettings = next.context?.elision ?? null;
      applied.push('elision');
    }

    if (next.context?.lazyTools !== last.context?.lazyTools) {
      session.lazyTools = next.context?.lazyTools ?? false;
      applied.push('lazyTools');
    }

    if (next.hookTimeoutMs !== last.hookTimeoutMs) {
      // The dispatcher reads its timeout at construction. v0: pending.
      pending.push('hookTimeoutMs (restart required)');
    }

    if (providerChanged(last, next)) {
      pending.push('provider.* (restart required)');
    }

    // Plugin enable/disable: actually apply now.
    const toggles = await applyPluginToggles(session, builtinsByName, last, next);
    for (const t of toggles.applied) applied.push(`plugins[${t.name}].enabled=${t.enabled}`);
    for (const p of toggles.pending) pending.push(p);

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

interface PluginToggle {
  readonly name: string;
  readonly enabled: boolean;
}

interface PluginToggleResult {
  readonly applied: ReadonlyArray<PluginToggle>;
  readonly pending: ReadonlyArray<string>;
}

/**
 * Walk every plugin in the union of (builtins, old config, new config) and
 * compare the resulting effective-enabled state. Apply the deltas via the
 * plugin host. Returns the set of toggles that were actually applied (success
 * cases only).
 */
async function applyPluginToggles(
  session: Session,
  builtinsByName: Map<string, BuiltinPluginRecord>,
  last: MoxxyConfig,
  next: MoxxyConfig,
): Promise<PluginToggleResult> {
  const allNames = new Set<string>([
    ...builtinsByName.keys(),
    ...Object.keys(last.plugins ?? {}),
    ...Object.keys(next.plugins ?? {}),
  ]);
  const applied: PluginToggle[] = [];
  const pending: string[] = [];

  const loaded = new Set(session.pluginHost.list().map((p) => p.name));

  for (const name of allNames) {
    const wasEnabled = effectiveEnabled(last, name);
    const nowEnabled = effectiveEnabled(next, name);
    if (wasEnabled === nowEnabled) continue;

    if (nowEnabled) {
      // Re-register
      const record = builtinsByName.get(name);
      if (!record) continue; // can't re-register a plugin we don't have a handle for
      if (loaded.has(name)) continue; // already registered
      if (!record.requirementsLoaded) {
        const reqs = await readPackageMoxxyRequirements(name, session.cwd);
        if (reqs.length > 0) record.requirements = reqs;
        record.requirementsLoaded = true;
      }
      try {
        session.pluginHost.registerStatic(record.plugin, record.requirements ? { requirements: record.requirements } : {});
        applied.push({ name, enabled: true });
      } catch (err) {
        if (err instanceof PluginRequirementError) {
          pending.push(`plugins[${name}].enabled=true (${err.message})`);
          continue;
        }
        pending.push(`plugins[${name}].enabled=true (${err instanceof Error ? err.message : String(err)})`);
      }
    } else {
      // Unload
      if (!loaded.has(name)) continue;
      try {
        await session.pluginHost.unload(name);
        applied.push({ name, enabled: false });
      } catch (err) {
        pending.push(`plugins[${name}].enabled=false (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  return { applied, pending };
}

function effectiveEnabled(cfg: MoxxyConfig, name: string): boolean {
  const entry = cfg.plugins?.[name];
  if (!entry) return true; // default: enabled when not mentioned
  return entry.enabled !== false;
}

function providerChanged(a: MoxxyConfig, b: MoxxyConfig): boolean {
  if (a.provider?.name !== b.provider?.name) return true;
  if (a.provider?.model !== b.provider?.model) return true;
  if (!shallowEqual(a.provider?.config, b.provider?.config)) return true;
  if (!arraysEqual(a.provider?.fallbacks, b.provider?.fallbacks)) return true;
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
