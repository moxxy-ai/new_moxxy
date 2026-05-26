import { describe, expect, it } from 'vitest';
import { runSlash, type SlashDeps } from './run-slash.js';

describe('runSlash', () => {
  it('shows a pending notice before awaiting a long-running registered command', async () => {
    const notices: Array<string | null> = [];
    let finish: ((value: { kind: 'text'; text: string }) => void) | null = null;
    const commandDone = new Promise<{ kind: 'text'; text: string }>((resolve) => {
      finish = resolve;
    });

    runSlash('/compact', {
      ...baseDeps(),
      setSystemNotice: (notice) => notices.push(notice),
      session: {
        id: 'sess-1',
        commands: {
          get: () => ({
            name: 'compact',
            description: 'Manually compact context',
            pendingNotice: 'compacting context...',
            handler: () => commandDone,
          }),
        },
      },
    } as unknown as SlashDeps);

    expect(notices).toEqual(['compacting context...']);
    finish?.({ kind: 'text', text: 'context compacted: 3 events, ~1.2k tokens saved' });
    await commandDone;
    await Promise.resolve();

    expect(notices).toEqual([
      'compacting context...',
      'context compacted: 3 events, ~1.2k tokens saved',
    ]);
  });

  it('passes the slash command name to channel session actions', async () => {
    const actions: Array<{ action: 'new' | 'clear' | 'exit'; notice?: string; command?: string }> = [];
    const commandDone = Promise.resolve({
      kind: 'session-action' as const,
      action: 'new' as const,
      notice: 'new session — conversation history cleared',
    });

    runSlash('/new', {
      ...baseDeps(),
      performSessionAction: (action, notice, command) => {
        actions.push({ action, notice, command });
      },
      session: {
        id: 'sess-1',
        commands: {
          get: () => ({
            name: 'new',
            description: 'Start fresh',
            handler: () => commandDone,
          }),
        },
      },
    } as unknown as SlashDeps);

    await commandDone;
    await Promise.resolve();

    expect(actions).toEqual([
      {
        action: 'new',
        notice: 'new session — conversation history cleared',
        command: '/new',
      },
    ]);
  });
});

function baseDeps(): SlashDeps {
  return {
    session: {
      id: 'sess-1',
      commands: { get: () => undefined },
    },
    providerName: 'openai',
    activeModel: 'gpt-test',
    modeName: 'tool-use',
    setSystemNotice: () => undefined,
    setOverlay: () => undefined,
    setYolo: () => undefined,
    setPicker: () => undefined,
    queueRef: { current: [] },
    setQueueCount: () => undefined,
    performSessionAction: () => undefined,
  } as unknown as SlashDeps;
}
