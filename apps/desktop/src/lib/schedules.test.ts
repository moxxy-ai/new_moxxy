import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSchedules, type ScheduleEntry } from './schedules';
import { mockTauri } from '@/__mocks__/tauri';

vi.mock('@/lib/tauri', () => import('@/__mocks__/tauri'));

function entry(id: string, partial: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id,
    name: `entry-${id}`,
    prompt: 'do thing',
    enabled: true,
    createdAt: 1,
    source: 'manual',
    cron: '* * * * *',
    ...partial,
  };
}

describe('useSchedules', () => {
  beforeEach(() => {
    mockTauri.reset();
    mockTauri.respond('schedules_list', () => []);
  });

  it('loads an empty list', async () => {
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('captures errors from list', async () => {
    mockTauri.respond('schedules_list', () => {
      throw new Error('disk corrupt');
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.error).toBe('disk corrupt'));
  });

  it('create() refreshes and returns the new entry', async () => {
    const stored: ScheduleEntry[] = [];
    mockTauri.respond('schedules_list', () => stored);
    mockTauri.respond('schedules_create', (args) => {
      const next = entry('1', {
        name: (args as { input: { name: string } }).input.name,
      });
      stored.push(next);
      return next;
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let created: ScheduleEntry | null = null;
    await act(async () => {
      created = await result.current.create({
        name: 'daily',
        prompt: 'p',
        cron: '0 9 * * *',
      });
    });
    expect((created as ScheduleEntry | null)?.name).toBe('daily');
    expect(result.current.entries).toHaveLength(1);
  });

  it('create() returns null and records the error on failure', async () => {
    mockTauri.respond('schedules_create', () => {
      throw new Error('invalid cron');
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let created: ScheduleEntry | null = null;
    await act(async () => {
      created = await result.current.create({
        name: 'bad',
        prompt: 'x',
        cron: 'nope',
      });
    });
    expect(created).toBeNull();
    expect(result.current.error).toBe('invalid cron');
  });

  it('update() refreshes after a patch', async () => {
    const stored: ScheduleEntry[] = [entry('1', { name: 'orig' })];
    mockTauri.respond('schedules_list', () => stored);
    mockTauri.respond('schedules_update', (args) => {
      const { id, patch } = args as { id: string; patch: Partial<ScheduleEntry> };
      const idx = stored.findIndex((s) => s.id === id);
      if (idx >= 0) stored[idx] = { ...stored[idx]!, ...patch };
      return stored[idx]!;
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    await act(async () => {
      await result.current.update('1', { name: 'renamed' });
    });
    expect(result.current.entries[0]?.name).toBe('renamed');
  });

  it('remove() refreshes after delete', async () => {
    const stored: ScheduleEntry[] = [entry('1')];
    mockTauri.respond('schedules_list', () => stored);
    mockTauri.respond('schedules_delete', (args) => {
      const idx = stored.findIndex((s) => s.id === (args as { id: string }).id);
      if (idx >= 0) stored.splice(idx, 1);
      return null;
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    await act(async () => {
      await result.current.remove('1');
    });
    expect(result.current.entries).toEqual([]);
  });

  it('setEnabled() toggles via the dedicated command', async () => {
    const stored: ScheduleEntry[] = [entry('1', { enabled: true })];
    mockTauri.respond('schedules_list', () => stored);
    mockTauri.respond('schedules_set_enabled', (args) => {
      const { id, enabled } = args as { id: string; enabled: boolean };
      const idx = stored.findIndex((s) => s.id === id);
      if (idx >= 0) stored[idx] = { ...stored[idx]!, enabled };
      return stored[idx]!;
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    await act(async () => {
      await result.current.setEnabled('1', false);
    });
    expect(result.current.entries[0]?.enabled).toBe(false);
  });

  it('validateCron() returns true for accepted expressions', async () => {
    mockTauri.respond('schedules_validate_cron', (args) => {
      const expr = (args as { expr: string }).expr;
      return expr === '0 9 * * *';
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(await result.current.validateCron('0 9 * * *')).toBe(true);
    expect(await result.current.validateCron('bogus')).toBe(false);
    expect(await result.current.validateCron('')).toBe(false);
  });

  it('validateCron() returns false when the command throws', async () => {
    mockTauri.respond('schedules_validate_cron', () => {
      throw new Error('cold runner');
    });
    const { result } = renderHook(() => useSchedules());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(await result.current.validateCron('0 9 * * *')).toBe(false);
  });
});
