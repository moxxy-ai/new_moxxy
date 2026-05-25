import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@moxxy/sdk';
import { Session, autoAllowResolver, collectTurn, silentLogger } from '@moxxy/core';
import { FakeProvider, textReply, toolUseReply, createFakeSession } from '@moxxy/testing';
import { toolUseModePlugin } from './index.js';

const sessionWith = (provider: FakeProvider): Session => {
  const session = createFakeSession({ provider });
  session.pluginHost.registerStatic(toolUseModePlugin);
  return session;
};

describe('toolUseMode end-to-end', () => {
  it('runs a plain text turn and emits the expected event sequence', async () => {
    const provider = new FakeProvider({ script: [textReply('hello there')] });
    const session = sessionWith(provider);

    const events = await collectTurn(session, 'hi');
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      'user_prompt',
      'mode_iteration',
      'provider_request',
      'assistant_chunk',
      'provider_response',
      'assistant_message',
    ]);
    const last = events[events.length - 1];
    if (last.type !== 'assistant_message') throw new Error('expected assistant_message last');
    expect(last.content).toBe('hello there');
    expect(last.stopReason).toBe('end_turn');
  });

  it('runs tool_use then continues loop with the result', async () => {
    const provider = new FakeProvider({
      script: [toolUseReply('echo', { msg: 'world' }, 'c1'), textReply('done: world')],
    });
    const session = sessionWith(provider);
    session.tools.register(
      defineTool({
        name: 'echo',
        description: 'returns msg',
        inputSchema: z.object({ msg: z.string() }),
        handler: (i) => i.msg,
      }),
    );

    const events = await collectTurn(session, 'go');
    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBe('world');

    const last = events[events.length - 1];
    if (last.type !== 'assistant_message') throw new Error('expected assistant_message last');
    expect(last.content).toBe('done: world');
  });

  it('records denial when permission resolver says no', async () => {
    const provider = new FakeProvider({
      script: [toolUseReply('Bash', { command: 'rm -rf /' }, 'c1'), textReply('aborted')],
    });
    const session = new Session({
      cwd: '/tmp',
      logger: silentLogger,
      permissionResolver: { name: 'deny', async check() { return { mode: 'deny', reason: 'no shells' }; } },
    });
    session.pluginHost.registerStatic({
      __moxxy: 'plugin' as const,
      name: 'shim',
      version: '0.0.0',
      providers: [
        {
          name: provider.name,
          models: [...provider.models],
          createClient: () => provider,
        },
      ],
    });
    session.providers.setActive(provider.name);
    session.pluginHost.registerStatic(toolUseModePlugin);
    session.tools.register(
      defineTool({
        name: 'Bash',
        description: '',
        inputSchema: z.object({ command: z.string() }),
        handler: () => 'should not run',
      }),
    );

    const events = await collectTurn(session, 'do it');
    const denied = events.find((e) => e.type === 'tool_call_denied');
    expect(denied).toBeDefined();
    const result = events.find((e) => e.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('denied');
  });

  it('handles tool handler throws as failure result', async () => {
    const provider = new FakeProvider({
      script: [toolUseReply('boom', {}, 'c1'), textReply('recovered')],
    });
    const session = sessionWith(provider);
    session.tools.register(
      defineTool({
        name: 'boom',
        description: '',
        inputSchema: z.object({}),
        handler: () => {
          throw new Error('explode');
        },
      }),
    );

    const events = await collectTurn(session, 'go');
    const result = events.find((e) => e.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('threw');
    expect(result.error?.message).toContain('explode');
  });

  it('aborts via stuck-loop detector when the model hammers the same call', async () => {
    // The detector fires when the same (name, input) pair appears
    // REPEAT_THRESHOLD times in the last WINDOW calls. A scripted
    // provider that returns the same toolUse over and over is the
    // canonical stuck-loop pattern — bail before burning the soft
    // maxIterations cap.
    const provider = new FakeProvider({
      script: Array(20).fill(toolUseReply('loop', {}, 'cN')),
    });
    const session = sessionWith(provider);
    session.tools.register(
      defineTool({
        name: 'loop',
        description: '',
        inputSchema: z.object({}),
        handler: () => 'ok',
      }),
    );
    void autoAllowResolver;

    const events = await collectTurn(session, 'spin');
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.type !== 'error') throw new Error();
    expect(errors[0].message).toMatch(/stuck pattern/);
    // And the safety-net cap is still wired — exercise its message
    // path by counting outgoing tool calls. The detector should fire
    // around iteration 3, well below the 500-iteration cap.
    const toolCalls = events.filter((e) => e.type === 'tool_call_requested');
    expect(toolCalls.length).toBeLessThan(10);
  });

  it('respects an explicit maxIterations cap when no stuck loop fires', async () => {
    // To hit the cap without tripping the detector, vary the input
    // each iteration so the recent-calls window never sees a repeat.
    const script = Array.from({ length: 60 }, (_, i) =>
      toolUseReply('vary', { i }, `c${i}`),
    );
    const provider = new FakeProvider({ script });
    const session = sessionWith(provider);
    session.tools.register(
      defineTool({
        name: 'vary',
        description: '',
        inputSchema: z.object({ i: z.number() }),
        handler: () => 'ok',
      }),
    );
    void autoAllowResolver;

    const events = await collectTurn(session, 'spin', { maxIterations: 3 });
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.type !== 'error') throw new Error();
    expect(errors[0].message).toMatch(/maxIterations/);
  });

  it('executes tools even when provider reports stopReason: end_turn', async () => {
    // Regression for the codex provider bug where Responses-API turns with
    // tool calls were reported as `stop_reason: end_turn`. The loop must
    // execute tools whenever they're requested, regardless of stopReason —
    // otherwise a single provider mis-mapping leaves orphan
    // tool_call_requested events and a stuck-looking pending dot.
    const provider = new FakeProvider({
      script: [
        [
          { type: 'message_start', model: 'fake' },
          { type: 'tool_use_start', id: 'c1', name: 'echo' },
          { type: 'tool_use_end', id: 'c1', input: { msg: 'hi' } },
          // Note: end_turn, NOT tool_use — the bug scenario.
          { type: 'message_end', stopReason: 'end_turn' },
        ],
        textReply('done'),
      ],
    });
    const session = sessionWith(provider);
    session.tools.register(
      defineTool({
        name: 'echo',
        description: 'returns msg',
        inputSchema: z.object({ msg: z.string() }),
        handler: (i) => i.msg,
      }),
    );

    const events = await collectTurn(session, 'go');
    const requested = events.find((e) => e.type === 'tool_call_requested');
    const result = events.find((e) => e.type === 'tool_result');
    expect(requested).toBeDefined();
    expect(result).toBeDefined();
    if (result?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('hi');
  });

  it('emits abort event when session is aborted mid-stream', async () => {
    const provider = new FakeProvider({
      script: [toolUseReply('slow', {}, 'c1'), textReply('after')],
    });
    const session = sessionWith(provider);
    session.tools.register(
      defineTool({
        name: 'slow',
        description: '',
        inputSchema: z.object({}),
        handler: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return 'done';
        },
      }),
    );

    setTimeout(() => session.abort('test abort'), 20);
    const events = await collectTurn(session, 'go');
    const aborted = events.find((e) => e.type === 'abort');
    // Either the abort fires before tool execution completes, or the tool_result has kind 'aborted'
    const result = events.find((e) => e.type === 'tool_result');
    if (result?.type === 'tool_result' && !result.ok) {
      expect(result.error?.kind === 'aborted' || result.error?.kind === 'threw').toBe(true);
    } else {
      expect(aborted).toBeDefined();
    }
  });
});
