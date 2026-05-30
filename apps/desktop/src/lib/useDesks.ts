import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { toErrorMessage } from './errors';
import { connectionStore } from './useConnection';
import type { Desk, DesksOverview } from '@moxxy/desktop-ipc-contract';

export interface UseDesks {
  readonly desks: ReadonlyArray<Desk>;
  readonly activeId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  /** Create a desk with an already-picked folder. Callers that need a
   *  one-shot "pick a folder, prompt for name, create" UX should call
   *  {@link pickFolder} first. */
  readonly create: (name: string, cwd: string) => Promise<Desk | null>;
  readonly remove: (id: string) => Promise<void>;
  readonly setActive: (id: string) => Promise<void>;
  readonly pickFolder: () => Promise<string | null>;
  readonly rename: (id: string, name: string) => Promise<void>;
}

const EMPTY: DesksOverview = { desks: [], activeId: null };

export function useDesks(): UseDesks {
  const [overview, setOverview] = useState<DesksOverview>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await api().invoke('desks.list');
      setOverview(next);
      setError(null);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pickFolder = useCallback(
    async (): Promise<string | null> => api().invoke('desks.pickFolder'),
    [],
  );

  const create = useCallback(
    async (name: string, cwd: string): Promise<Desk | null> => {
      try {
        const desk = await api().invoke('desks.create', { name, cwd });
        await refresh();
        return desk;
      } catch (e) {
        setError(toErrorMessage(e));
        return null;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api().invoke('desks.remove', { id });
        await refresh();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refresh],
  );

  const setActive = useCallback(
    async (id: string): Promise<void> => {
      // Optimistic: flip the active id immediately so the sidebar
      // highlight + active workspace follow the click without waiting
      // for the IPC + the supervisor's full re-resolve. Also pre-bind
      // the connection store's active id so the chat surface,
      // context rail, and chat store all swap to the new workspace
      // in the same render — without this they wait for the main
      // process to push a `connection.changed` for the new workspace,
      // and meanwhile the UI is still wired to the old chat state.
      const prev = overview.activeId;
      setOverview((o) => ({ ...o, activeId: id }));
      connectionStore.setActive(id);
      try {
        await api().invoke('desks.setActive', { id });
        await refresh();
      } catch (e) {
        setOverview((o) => ({ ...o, activeId: prev }));
        if (prev) connectionStore.setActive(prev);
        setError(toErrorMessage(e));
      }
    },
    [overview.activeId, refresh],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<void> => {
      try {
        await api().invoke('desks.rename', { id, name });
        await refresh();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refresh],
  );

  return {
    desks: overview.desks,
    activeId: overview.activeId,
    loading,
    error,
    refresh,
    create,
    remove,
    setActive,
    pickFolder,
    rename,
  };
}
