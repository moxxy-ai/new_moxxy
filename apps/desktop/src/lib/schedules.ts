import { useCallback, useEffect, useState } from 'react';
import { invoke } from './tauri';

/**
 * Shape mirrors `moxxy_desktop_core::schedule::ScheduleEntry` which is
 * itself a transcription of `packages/plugin-scheduler/src/store.ts`.
 * The Rust side is authoritative for what's accepted on the wire.
 */
export interface ScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cron?: string;
  readonly runAt?: number;
  readonly timeZone?: string;
  readonly channel?: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly lastRunAt?: number;
  readonly lastResult?: 'ok' | 'error';
  readonly lastError?: string;
  readonly source: 'manual' | 'skill' | 'workflow';
  readonly skillName?: string;
  readonly workflowName?: string;
}

export interface NewSchedule {
  readonly name: string;
  readonly prompt: string;
  readonly cron?: string;
  readonly runAt?: number;
  readonly timeZone?: string;
  readonly channel?: string;
  readonly model?: string;
}

export interface SchedulePatch {
  readonly name?: string;
  readonly prompt?: string;
  readonly cron?: string | null;
  readonly runAt?: number | null;
  readonly timeZone?: string | null;
  readonly channel?: string | null;
  readonly model?: string | null;
  readonly enabled?: boolean;
}

export interface SchedulesApi {
  readonly entries: ReadonlyArray<ScheduleEntry>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly create: (input: NewSchedule) => Promise<ScheduleEntry | null>;
  readonly update: (id: string, patch: SchedulePatch) => Promise<ScheduleEntry | null>;
  readonly remove: (id: string) => Promise<void>;
  readonly setEnabled: (id: string, enabled: boolean) => Promise<void>;
  readonly validateCron: (expr: string) => Promise<boolean>;
}

export function useSchedules(): SchedulesApi {
  const [entries, setEntries] = useState<ReadonlyArray<ScheduleEntry>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<ScheduleEntry[]>('schedules_list');
      setEntries(list);
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
    async (input: NewSchedule): Promise<ScheduleEntry | null> => {
      try {
        const entry = await invoke<ScheduleEntry>('schedules_create', { input });
        await refresh();
        return entry;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: SchedulePatch): Promise<ScheduleEntry | null> => {
      try {
        const entry = await invoke<ScheduleEntry>('schedules_update', {
          id,
          patch,
        });
        await refresh();
        return entry;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await invoke('schedules_delete', { id });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await invoke('schedules_set_enabled', { id, enabled });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const validateCron = useCallback(async (expr: string): Promise<boolean> => {
    if (!expr.trim()) return false;
    try {
      return await invoke<boolean>('schedules_validate_cron', { expr });
    } catch {
      return false;
    }
  }, []);

  return {
    entries,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    setEnabled,
    validateCron,
  };
}
