import { useEffect, useState } from 'react';
import { invoke, subscribe } from './tauri';

/**
 * Selected slice of the runner's SessionInfo. The runner emits much
 * more; we surface just what the wizard / settings panel actually use.
 */
export interface RunnerInfo {
  readonly activeProvider?: string | null;
  readonly activeModel?: string | null;
  readonly activeMode?: string | null;
  readonly providers?: ReadonlyArray<{ name: string }>;
  readonly modes?: ReadonlyArray<{ name: string }>;
}

interface RunnerInfoState {
  readonly info: RunnerInfo | null;
  /** True until the first probe completes — distinct from `info === null`
   *  which can mean "runner not attached yet". */
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

function normalize(raw: unknown): RunnerInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pickStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const arrOfName = (v: unknown): ReadonlyArray<{ name: string }> => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'object' && x && 'name' in x ? String((x as { name: unknown }).name) : null))
      .filter((s): s is string => Boolean(s))
      .map((name) => ({ name }));
  };
  return {
    activeProvider:
      pickStr(r.activeProvider) ?? pickStr(r.provider) ?? null,
    activeModel: pickStr(r.activeModel) ?? pickStr(r.model) ?? null,
    activeMode: pickStr(r.activeMode) ?? pickStr(r.mode) ?? null,
    providers: arrOfName(r.providers),
    modes: arrOfName(r.modes),
  };
}

/**
 * Subscribes to `runner.info.changed` so the wizard collapses the
 * moment the runner reports an active provider — no manual refresh
 * needed once the user finishes the form.
 */
export function useRunnerInfo(): RunnerInfoState {
  const [info, setInfo] = useState<RunnerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const raw = await invoke<unknown>('runner_info');
      setInfo(normalize(raw));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const unsubs = [
      subscribe<unknown>('runner.info.changed', (next) => {
        setInfo(normalize(next));
      }),
      // After the bridge attaches, fetch fresh info — the
      // `runner.ready` event fires from the boot task once the
      // bridge is in.
      subscribe<boolean>('runner.ready', (ready) => {
        if (ready) void refresh();
      }),
    ];
    return () => {
      for (const u of unsubs) void u.then((fn) => fn());
    };
  }, []);

  return { info, loading, error, refresh };
}
