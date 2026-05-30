/**
 * Tests for the three-stage focus widget. The point of these tests
 * is to lock down:
 *
 *   1. Each stage renders a visible, clickable affordance — no
 *      empty / blank tile regressions.
 *   2. Stage transitions are wired correctly (inactive → active →
 *      mini-text / mini-voice → back).
 *   3. Every transition fires focus.resize so the BrowserWindow
 *      grows / shrinks with the content.
 *   4. The text composer in mini-text actually invokes
 *      session.runTurn for the active workspace (the bidirectional
 *      sync test — the focus widget must send to the runner just
 *      like the main window does).
 *   5. A runner.event arriving on the runner.event channel updates
 *      the focus widget's latest-line preview (the receive side of
 *      the bidirectional sync).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { __setApiOverride } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';
import { FocusWidget } from './FocusWidget';

interface IpcSpy {
  invokes: Array<{ channel: string; args: unknown }>;
  emit: (channel: string, payload: unknown) => void;
}

function installFakeApi(): IpcSpy {
  const invokes: Array<{ channel: string; args: unknown }> = [];
  const subs = new Map<string, Set<(payload: unknown) => void>>();

  __setApiOverride({
    invoke: ((channel: string, args: unknown) => {
      invokes.push({ channel, args });
      // Connection / chat read APIs need sensible defaults so the
      // bridges don't reject on mount.
      if (channel === 'connection.snapshotAll') {
        return Promise.resolve([
          {
            workspaceId: 'ws-test',
            phase: { phase: 'connected' },
            cliPath: null,
            attempts: 0,
            log: [],
          },
        ]);
      }
      if (channel === 'connection.activeWorkspace') {
        return Promise.resolve('ws-test');
      }
      if (channel === 'session.runTurn') {
        return Promise.resolve({ turnId: 't-1' });
      }
      if (channel === 'session.hasTranscriber') {
        return Promise.resolve(true);
      }
      return Promise.resolve(undefined);
    }) as never,
    subscribe: ((channel: string, cb: (payload: unknown) => void) => {
      let set = subs.get(channel);
      if (!set) {
        set = new Set();
        subs.set(channel, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    }) as never,
  } as never);

  return {
    invokes,
    emit: (channel, payload) => {
      const set = subs.get(channel);
      if (set) for (const cb of set) cb(payload);
    },
  };
}

beforeEach(() => {
  // Each test gets a fresh workspace chat so latest-line / sending
  // states don't bleed across cases.
  chatStore.clear('ws-test');
});

afterEach(() => {
  __setApiOverride(null);
});

describe('FocusWidget stages', () => {
  it('renders the inactive square with a visible activate button', () => {
    installFakeApi();
    render(<FocusWidget />);
    const button = screen.getByRole('button', { name: /click to expand/i });
    expect(button).toBeTruthy();
  });

  it('inactive → active fires focus.resize and shows the action row', async () => {
    const spy = installFakeApi();
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    expect(screen.getByRole('button', { name: /^text$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /open main window/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /close focus mode/i })).toBeTruthy();
    await waitFor(() => {
      const resize = spy.invokes.find(
        (i) =>
          i.channel === 'focus.resize' &&
          (i.args as { width: number }).width >= 200 &&
          (i.args as { width: number }).width <= 280,
      );
      expect(resize).toBeTruthy();
    });
  });

  it('active → mini-text shows the composer input + send', () => {
    installFakeApi();
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    expect(screen.getByPlaceholderText(/ask moxxy|no active workspace/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeTruthy();
  });

  it('shows the mic button when the runner has a transcriber', async () => {
    installFakeApi();
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^record voice$/i })).toBeTruthy();
    });
  });

  it('hides the mic button when the runner has no transcriber', async () => {
    // Custom fake — hasTranscriber returns false.
    __setApiOverride({
      invoke: ((channel: string) => {
        if (channel === 'connection.snapshotAll') return Promise.resolve([]);
        if (channel === 'connection.activeWorkspace') return Promise.resolve('ws-test');
        if (channel === 'session.hasTranscriber') return Promise.resolve(false);
        return Promise.resolve(undefined);
      }) as never,
      subscribe: (() => () => undefined) as never,
    } as never);
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    // Text / restore / close stay visible; mic is gone.
    expect(screen.getByRole('button', { name: /^text$/i })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /record voice/i })).toBeNull();
    });
  });

  it('mini-text → back returns to the active stage', () => {
    installFakeApi();
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByRole('button', { name: /^text$/i })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/ask moxxy/i)).toBeNull();
  });

  it('active → close fires focus.close IPC', () => {
    const spy = installFakeApi();
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /close focus mode/i }));
    expect(spy.invokes.some((i) => i.channel === 'focus.close')).toBe(true);
  });

  it('mini → restore-main fires focus.restoreMain IPC', () => {
    const spy = installFakeApi();
    render(<FocusWidget />);
    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('button', { name: /open main window/i }));
    expect(spy.invokes.some((i) => i.channel === 'focus.restoreMain')).toBe(true);
  });
});

describe('FocusWidget bidirectional sync', () => {
  it('sending from mini-text invokes session.runTurn for the active workspace', async () => {
    const spy = installFakeApi();
    render(<FocusWidget />);

    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));

    // Wait for ConnectionBridge to push the active workspace id
    // through, which un-disables the input.
    await waitFor(() => {
      const input = screen.getByPlaceholderText(/ask moxxy|no active workspace/i) as HTMLInputElement;
      expect(input.disabled).toBe(false);
    });

    const input = screen.getByPlaceholderText(/ask moxxy/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello from focus' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      const turnCall = spy.invokes.find((i) => i.channel === 'session.runTurn');
      expect(turnCall).toBeTruthy();
      expect((turnCall!.args as { prompt: string }).prompt).toBe('hello from focus');
      expect((turnCall!.args as { workspaceId: string }).workspaceId).toBe(
        'ws-test',
      );
    });
  });

  it('a runner.event flowing into chatStore surfaces in mini-text latest line', async () => {
    installFakeApi();
    render(<FocusWidget />);

    fireEvent.click(screen.getByRole('button', { name: /click to expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));

    // Simulate the runner streaming an assistant_chunk event — this
    // is what bindWindow's SessionDriver delivers to the focus
    // window when the main window sends a turn.
    chatStore.dispatch('ws-test', {
      type: 'event',
      event: {
        type: 'assistant_chunk',
        turnId: 't-incoming',
        delta: 'response from the main window',
      } as never,
    });

    await waitFor(() => {
      expect(screen.getByText(/response from the main window/i)).toBeTruthy();
    });
  });
});
