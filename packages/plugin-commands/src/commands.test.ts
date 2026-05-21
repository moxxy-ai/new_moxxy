import { describe, expect, it } from 'vitest';
import { commandsPlugin } from './index.js';
import type { CommandDef, EmittedEvent, MoxxyEvent } from '@moxxy/sdk';

const fakeSession = {
  id: 'sess-1',
  cwd: '/tmp',
  providers: { getActiveName: () => 'anthropic' },
  loops: { getActive: () => ({ name: 'tool-use' }) },
  tools: { list: () => [{}, {}, {}] },
  skills: { list: () => [{}] },
  agents: { list: () => [{ name: 'researcher', description: 'web' }] },
  commands: { list: () => commandsPlugin.commands ?? [] },
  pluginHost: { list: () => [{}] },
};

function callCommand(name: string, channel = 'tui'): ReturnType<CommandDef['handler']> {
  const cmd = (commandsPlugin.commands ?? []).find((c) => c.name === name);
  if (!cmd) throw new Error(`missing command: ${name}`);
  return cmd.handler({
    channel,
    sessionId: 'sess-1' as never,
    args: '',
    session: fakeSession,
  });
}

describe('@moxxy/plugin-commands', () => {
  it('registers the universal command set', () => {
    const names = (commandsPlugin.commands ?? []).map((c) => c.name).sort();
    expect(names).toEqual(['clear', 'compact', 'exit', 'help', 'info', 'new']);
  });

  it('/info returns a text block with session header fields', async () => {
    const out = await callCommand('info');
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.text).toContain('provider:');
      expect(out.text).toContain('loop:');
      expect(out.text).toContain('agents:');
    }
  });

  it('/clear and /new return session-action variants', async () => {
    const clear = await callCommand('clear');
    expect(clear.kind).toBe('session-action');
    if (clear.kind === 'session-action') expect(clear.action).toBe('clear');
    const fresh = await callCommand('new');
    expect(fresh.kind).toBe('session-action');
    if (fresh.kind === 'session-action') expect(fresh.action).toBe('new');
  });

  it('/exit aliases /quit /q', () => {
    const exit = (commandsPlugin.commands ?? []).find((c) => c.name === 'exit');
    expect(exit?.aliases).toEqual(['quit', 'q']);
  });

  it('/help filters by channel scope', async () => {
    const out = await callCommand('help', 'telegram');
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.text).toContain('/compact');
      expect(out.text).toContain('/info');
      expect(out.text).toContain('/help');
    }
  });

  it('/compact runs the active compactor and appends its compaction event', async () => {
    const existing = [
      { type: 'user_prompt', seq: 0, sessionId: 'sess-1', turnId: 'turn-1', source: 'user', text: 'old' },
      { type: 'assistant_message', seq: 1, sessionId: 'sess-1', turnId: 'turn-1', source: 'model', content: 'answer', stopReason: 'end_turn' },
      { type: 'user_prompt', seq: 2, sessionId: 'sess-1', turnId: 'turn-2', source: 'user', text: 'now' },
    ] as unknown as MoxxyEvent[];
    const appended: EmittedEvent[] = [];
    const session = {
      ...fakeSession,
      signal: new AbortController().signal,
      log: {
        length: existing.length,
        slice: () => existing,
        asReader: () => ({
          length: existing.length,
          at: (seq: number) => existing[seq],
          slice: () => existing,
          ofType: () => [],
          byTurn: () => [],
          toJSON: () => existing,
        }),
        append: async (event: EmittedEvent) => {
          appended.push(event);
          return event as unknown as MoxxyEvent;
        },
      },
      compactors: {
        getActive: () => ({
          name: 'fake-compact',
          shouldCompact: () => false,
          compact: async (events: ReadonlyArray<MoxxyEvent>) => {
            expect(events).toBe(existing);
            return {
              type: 'compaction',
              sessionId: 'sess-1',
              turnId: 'turn-2',
              source: 'compactor',
              compactor: 'fake-compact',
              replacedRange: [0, 2],
              summary: 'old conversation summary',
              tokensSaved: 315_810,
            } as const;
          },
        }),
      },
    };

    const compact = (commandsPlugin.commands ?? []).find((c) => c.name === 'compact');
    if (!compact) throw new Error('missing command: compact');
    const out = await compact.handler({
      channel: 'tui',
      sessionId: 'sess-1' as never,
      args: '',
      session,
    });

    expect(out).toEqual({
      kind: 'text',
      text: 'context compacted: 3 events, ~315.8k tokens saved',
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: 'compaction',
      compactor: 'fake-compact',
      summary: 'old conversation summary',
      tokensSaved: 315_810,
    });
  });

  it('/compact exposes a pending notice for interactive channels', () => {
    const compact = (commandsPlugin.commands ?? []).find((c) => c.name === 'compact');
    expect(compact).toMatchObject({ pendingNotice: 'compacting context...' });
  });
});
