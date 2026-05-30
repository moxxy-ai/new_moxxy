/**
 * useWorkflows hook tests — drive the IPC surface through the fake
 * api shim and assert the hook surfaces list/error/lastRun the way the
 * panel expects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { __setApiOverride } from './api';
import { useWorkflows } from './useWorkflows';
import type { MoxxyApi, WorkflowRun, WorkflowSummary } from '@moxxy/desktop-ipc-contract';

function fakeApi(invoke: MoxxyApi['invoke']): MoxxyApi {
  return { invoke, subscribe: () => () => {} };
}

afterEach(() => __setApiOverride(null));

const sample: WorkflowSummary = {
  name: 'daily-summary',
  description: 'Rolls up the inbox',
  enabled: true,
  scope: 'global',
  steps: 3,
  triggers: 'cron(0 8 * * *)',
};

describe('useWorkflows', () => {
  it('loads on mount', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'workflows.list') return [sample];
      throw new Error(`unexpected ${cmd}`);
    });
    __setApiOverride(fakeApi(invoke as unknown as MoxxyApi['invoke']));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.list).toEqual([sample]);
    expect(invoke).toHaveBeenCalledWith('workflows.list');
  });

  it('surfaces list errors', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('boom');
    });
    __setApiOverride(fakeApi(invoke as unknown as MoxxyApi['invoke']));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
  });

  it('refreshes after setEnabled', async () => {
    let toggled = false;
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
      if (cmd === 'workflows.list') {
        return [{ ...sample, enabled: !toggled }];
      }
      if (cmd === 'workflows.setEnabled') {
        toggled = true;
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    __setApiOverride(fakeApi(invoke as unknown as MoxxyApi['invoke']));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.list[0]?.enabled).toBe(true);

    await act(async () => {
      await result.current.setEnabled('daily-summary', false);
    });

    await waitFor(() => {
      expect(result.current.list[0]?.enabled).toBe(false);
    });
    expect(invoke).toHaveBeenCalledWith('workflows.setEnabled', {
      name: 'daily-summary',
      enabled: false,
    });
  });

  it('flips enabled optimistically before the IPC resolves', async () => {
    let resolveToggle: (() => void) | undefined;
    let serverEnabled = true;
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      if (cmd === 'workflows.list') return [{ ...sample, enabled: serverEnabled }];
      if (cmd === 'workflows.setEnabled') {
        await new Promise<void>((r) => {
          resolveToggle = r;
        });
        serverEnabled = (args as { enabled: boolean }).enabled;
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    __setApiOverride(fakeApi(invoke as unknown as MoxxyApi['invoke']));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.list[0]?.enabled).toBe(true);

    // Trigger the toggle but DON'T await — assert the optimistic flip
    // is visible while the IPC promise is still pending.
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.setEnabled('daily-summary', false);
    });
    await waitFor(() => expect(result.current.list[0]?.enabled).toBe(false));

    // Finalise the IPC + the refresh, ensuring nothing throws.
    resolveToggle!();
    await act(async () => {
      await pending;
    });
    expect(result.current.list[0]?.enabled).toBe(false);
  });

  it('stashes the last run', async () => {
    const run: WorkflowRun = {
      ok: true,
      output: 'all good',
      steps: [{ id: 's1', status: 'completed' }],
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'workflows.list') return [];
      if (cmd === 'workflows.run') return run;
      throw new Error(`unexpected ${cmd}`);
    });
    __setApiOverride(fakeApi(invoke as unknown as MoxxyApi['invoke']));

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.run('daily-summary');
    });

    expect(result.current.lastRun).toEqual({ name: 'daily-summary', result: run });
  });
});
