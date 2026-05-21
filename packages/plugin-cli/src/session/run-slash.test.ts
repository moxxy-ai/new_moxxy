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
});

function baseDeps(): SlashDeps {
  return {
    session: {
      id: 'sess-1',
      commands: { get: () => undefined },
    },
    providerName: 'openai',
    activeModel: 'gpt-test',
    loopName: 'tool-use',
    setSystemNotice: () => undefined,
    setOverlay: () => undefined,
    setYolo: () => undefined,
    setPicker: () => undefined,
    queueRef: { current: [] },
    setQueueCount: () => undefined,
    performSessionAction: () => undefined,
  } as unknown as SlashDeps;
}
