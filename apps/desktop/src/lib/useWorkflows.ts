import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { toErrorMessage } from './errors';
import type { WorkflowRun, WorkflowSummary } from '@moxxy/desktop-ipc-contract';

export interface UseWorkflows {
  readonly list: ReadonlyArray<WorkflowSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly lastRun: { name: string; result: WorkflowRun } | null;
  readonly refresh: () => Promise<void>;
  readonly setEnabled: (name: string, enabled: boolean) => Promise<void>;
  readonly run: (name: string) => Promise<void>;
}

export function useWorkflows(): UseWorkflows {
  const [list, setList] = useState<ReadonlyArray<WorkflowSummary>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<UseWorkflows['lastRun']>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await api().invoke('workflows.list');
      setList(next);
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

  const setEnabled = useCallback(
    async (name: string, enabled: boolean): Promise<void> => {
      // Optimistic flip — flicker-free toggle, IPC + refresh corrects
      // if the runner rejects (e.g. workflow doesn't exist).
      const prev = list;
      setList((cur) => cur.map((w) => (w.name === name ? { ...w, enabled } : w)));
      try {
        await api().invoke('workflows.setEnabled', { name, enabled });
        await refresh();
      } catch (e) {
        setList(prev);
        setError(toErrorMessage(e));
      }
    },
    [list, refresh],
  );

  const run = useCallback(
    async (name: string): Promise<void> => {
      try {
        const result = await api().invoke('workflows.run', { name });
        setLastRun({ name, result });
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [],
  );

  return { list, loading, error, lastRun, refresh, setEnabled, run };
}
