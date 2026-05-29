import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchedulePanel } from './schedule-panel';
import type { SchedulesApi, ScheduleEntry } from '@/lib/schedules';

function entry(id: string, overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id,
    name: `entry-${id}`,
    prompt: 'do',
    cron: '0 9 * * *',
    enabled: true,
    createdAt: 1,
    source: 'manual',
    ...overrides,
  };
}

// Mutable mirror of SchedulesApi so tests can poke at the readonly fields
// (entries, error) directly to drive scenarios.
type MutableApi = {
  -readonly [K in keyof SchedulesApi]: SchedulesApi[K];
} & { _entries: ScheduleEntry[] };

function fakeApi(initial: ScheduleEntry[] = []): MutableApi {
  const stored: ScheduleEntry[] = [...initial];
  const api: MutableApi = {
    _entries: stored,
    entries: stored,
    loading: false,
    error: null,
    refresh: async () => {
      api.entries = stored.slice();
    },
    create: async (input) => {
      const next = entry(String(stored.length + 1), {
        name: input.name,
        prompt: input.prompt,
        cron: input.cron,
      });
      stored.push(next);
      api.entries = stored.slice();
      return next;
    },
    update: async (id, patch) => {
      const idx = stored.findIndex((s) => s.id === id);
      if (idx >= 0) stored[idx] = { ...stored[idx]!, ...patch } as ScheduleEntry;
      api.entries = stored.slice();
      return stored[idx] ?? null;
    },
    remove: async (id) => {
      const idx = stored.findIndex((s) => s.id === id);
      if (idx >= 0) stored.splice(idx, 1);
      api.entries = stored.slice();
    },
    setEnabled: async (id, enabled) => {
      const idx = stored.findIndex((s) => s.id === id);
      if (idx >= 0) stored[idx] = { ...stored[idx]!, enabled };
      api.entries = stored.slice();
    },
    validateCron: async (expr) => expr.split(/\s+/).filter(Boolean).length === 5,
  };
  return api;
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('<SchedulePanel />', () => {
  it('renders an empty state with the create form', () => {
    const api = fakeApi([]);
    render(<SchedulePanel api={api} />);
    expect(screen.getByText(/No schedules yet/)).toBeInTheDocument();
    expect(screen.getByTestId('schedule-create-form')).toBeInTheDocument();
  });

  it('shows existing entries with status + cadence', () => {
    const api = fakeApi([entry('a', { name: 'standup', cron: '0 9 * * 1-5' })]);
    render(<SchedulePanel api={api} />);
    const row = screen.getByTestId('schedule-row-a');
    expect(row).toHaveTextContent('standup');
    expect(row).toHaveTextContent('0 9 * * 1-5');
  });

  it('disables the submit button until cron validation passes', async () => {
    vi.useRealTimers(); // userEvent + debounce don't play nice with fake timers
    const api = fakeApi([]);
    render(<SchedulePanel api={api} />);
    const submit = screen.getByTestId('schedule-create-submit');
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByTestId('schedule-create-name'), 'daily');
    await userEvent.type(
      screen.getByTestId('schedule-create-prompt'),
      'log heartbeat',
    );
    // Cron prefilled to 0 9 * * * — should validate true once the debounce fires.
    await waitFor(() =>
      expect(screen.getByTestId('schedule-create-cron-validity')).toHaveAttribute(
        'data-valid',
        'true',
      ),
    );
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('creates a schedule via the form', async () => {
    vi.useRealTimers();
    const api = fakeApi([]);
    const { rerender } = render(<SchedulePanel api={api} />);

    await userEvent.type(screen.getByTestId('schedule-create-name'), 'daily');
    await userEvent.type(
      screen.getByTestId('schedule-create-prompt'),
      'log heartbeat',
    );
    await waitFor(() =>
      expect(screen.getByTestId('schedule-create-cron-validity')).toHaveAttribute(
        'data-valid',
        'true',
      ),
    );
    await userEvent.click(screen.getByTestId('schedule-create-submit'));

    await waitFor(() => expect(api._entries.length).toBe(1));
    rerender(<SchedulePanel api={api} />);
    expect(screen.getByTestId(`schedule-row-${api._entries[0]!.id}`)).toHaveTextContent(
      'daily',
    );
  });

  it('toggles enabled state', async () => {
    vi.useRealTimers();
    const api = fakeApi([entry('a', { enabled: true })]);
    const { rerender } = render(<SchedulePanel api={api} />);

    await userEvent.click(screen.getByTestId('schedule-toggle-a'));
    await waitFor(() => expect(api._entries[0]!.enabled).toBe(false));
    rerender(<SchedulePanel api={api} />);
    expect(screen.getByTestId('schedule-row-a')).toHaveAttribute(
      'data-enabled',
      'false',
    );
  });

  it('deletes after confirm', async () => {
    vi.useRealTimers();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = fakeApi([entry('a')]);
    const { rerender } = render(<SchedulePanel api={api} />);
    await userEvent.click(screen.getByTestId('schedule-delete-a'));
    await waitFor(() => expect(api._entries.length).toBe(0));
    rerender(<SchedulePanel api={api} />);
    expect(screen.queryByTestId('schedule-row-a')).toBeNull();
    confirmSpy.mockRestore();
  });

  it('cancels deletion when confirm returns false', async () => {
    vi.useRealTimers();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = fakeApi([entry('a')]);
    render(<SchedulePanel api={api} />);
    await userEvent.click(screen.getByTestId('schedule-delete-a'));
    expect(api._entries.length).toBe(1);
    confirmSpy.mockRestore();
  });

  it('marks skill-sourced entries as read-only', () => {
    const api = fakeApi([
      entry('a', { source: 'skill', skillName: 'morning-brief' }),
    ]);
    render(<SchedulePanel api={api} />);
    expect(screen.getByTestId('schedule-toggle-a')).toBeDisabled();
    expect(screen.getByTestId('schedule-delete-a')).toBeDisabled();
  });

  it('surfaces error state from the api', () => {
    const api = fakeApi([]);
    api.error = 'disk full';
    render(<SchedulePanel api={api} />);
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');
  });
});
