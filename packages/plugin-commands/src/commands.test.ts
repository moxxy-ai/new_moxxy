import { describe, expect, it } from 'vitest';
import { commandsPlugin } from './index.js';
import type { CommandDef } from '@moxxy/sdk';

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
    expect(names).toEqual(['clear', 'exit', 'help', 'info', 'new']);
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
      expect(out.text).toContain('/info');
      expect(out.text).toContain('/help');
    }
  });
});
