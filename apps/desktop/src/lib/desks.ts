import { useCallback, useEffect, useState } from 'react';
import { invoke } from './tauri';

/**
 * Shape mirrors `moxxy_desktop_core::desks::Desk`. The Rust side is
 * authoritative; keep this in lockstep when the Rust schema changes.
 */
export interface Desk {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly color: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface DesksApi {
  readonly desks: ReadonlyArray<Desk>;
  readonly active: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly create: (desk: Desk) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly setActive: (id: string) => Promise<void>;
  /** Open the OS folder picker via the Rust command. */
  readonly pickFolder: () => Promise<string | null>;
}

/**
 * Hook over the desks commands. Single source of truth for the sidebar:
 * loads on mount, refreshes after every mutation, surfaces errors.
 *
 * Holds no derived state — the Rust store is authoritative. Subscribers
 * always see the latest snapshot via `refresh()`.
 */
export function useDesks(): DesksApi {
  const [desks, setDesks] = useState<ReadonlyArray<Desk>>([]);
  const [active, setActiveState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, current] = await Promise.all([
        invoke<Desk[]>('desks_list'),
        invoke<string | null>('desks_active'),
      ]);
      setDesks(list);
      setActiveState(current);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (desk: Desk) => {
      await invoke('desks_upsert', { desk });
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await invoke('desks_remove', { id });
      await refresh();
    },
    [refresh],
  );

  const setActive = useCallback(
    async (id: string) => {
      await invoke('desks_set_active', { id });
      await refresh();
    },
    [refresh],
  );

  const pickFolder = useCallback(async () => {
    return invoke<string | null>('desks_pick_folder');
  }, []);

  return {
    desks,
    active,
    loading,
    error,
    refresh,
    create,
    remove,
    setActive,
    pickFolder,
  };
}

/** Sanitise free-form text into a valid `DeskId` (matches Rust's rules). */
export function slugifyDeskId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Pick the next swatch in rotation given the desks already created. */
export function nextSwatch(
  desks: ReadonlyArray<Desk>,
  swatches: ReadonlyArray<string>,
): string {
  if (swatches.length === 0) return '#818cf8';
  return swatches[desks.length % swatches.length]!;
}
