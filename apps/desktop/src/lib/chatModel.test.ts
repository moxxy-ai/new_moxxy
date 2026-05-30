/**
 * Chat model tests — drive the runtime directly (no React render) and
 * assert on the folded render tree + streaming/flag state.
 */

import { describe, expect, it } from 'vitest';
import type { MoxxyEvent } from '@moxxy/sdk';
import {
  applyAction,
  applyEvent,
  buildRenderNodes,
  createRuntime,
  type ChatRuntime,
  type FoldedBlock,
} from './chatModel';

let n = 0;
function evt(type: MoxxyEvent['type'], extra: Record<string, unknown>): MoxxyEvent {
  n += 1;
  return {
    id: `e${n}`,
    seq: n,
    ts: n,
    turnId: 'T1',
    sessionId: 'S',
    source: 'model',
    type,
    ...extra,
  } as unknown as MoxxyEvent;
}
const userPrompt = (text: string): MoxxyEvent => evt('user_prompt', { text });
const chunk = (delta: string): MoxxyEvent => evt('assistant_chunk', { delta });
const assistant = (content: string, stopReason = 'end_turn'): MoxxyEvent =>
  evt('assistant_message', { content, stopReason });
const toolReq = (callId: string, name: string, input: unknown): MoxxyEvent =>
  evt('tool_call_requested', { callId, name, input });
const toolRes = (callId: string, ok: boolean, output?: unknown, error?: unknown): MoxxyEvent =>
  evt('tool_result', {
    callId,
    ok,
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error } : {}),
  });
const errorEvent = (message: string): MoxxyEvent => evt('error', { kind: 'fatal', message });

function blocksOf(rt: ChatRuntime): FoldedBlock[] {
  return buildRenderNodes(rt.log.toArray(), rt.extensions)
    .filter((node): node is { kind: 'block'; block: FoldedBlock } => node.kind === 'block')
    .map((node) => node.block);
}

describe('chat model runtime', () => {
  it('starts empty', () => {
    const rt = createRuntime();
    expect(blocksOf(rt)).toEqual([]);
    expect(rt.sending).toBe(false);
    expect(rt.activeTurnId).toBeNull();
  });

  it('send_started flips sending + activeTurnId without adding a block', () => {
    const rt = createRuntime();
    applyAction(rt, { type: 'send_started', turnId: 'T1' });
    expect(rt.sending).toBe(true);
    expect(rt.activeTurnId).toBe('T1');
    expect(blocksOf(rt)).toEqual([]);
  });

  it('accumulates assistant chunks into streamingText — never into the log (O(1))', () => {
    const rt = createRuntime();
    applyEvent(rt, chunk('hel'));
    applyEvent(rt, chunk('lo'));
    applyEvent(rt, chunk('!'));
    expect(rt.streamingText).toBe('hello!');
    expect(rt.log.length).toBe(0);
    expect(blocksOf(rt)).toEqual([]);
  });

  it('commits the streamed text on assistant_message and clears the stream', () => {
    const rt = createRuntime();
    applyEvent(rt, chunk('hi'));
    applyEvent(rt, assistant('hi.', 'end_turn'));
    expect(rt.streamingText).toBe('');
    const blocks = blocksOf(rt);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'event' });
    const ev = (blocks[0] as Extract<FoldedBlock, { kind: 'event' }>).event;
    expect(ev).toMatchObject({ type: 'assistant_message', content: 'hi.' });
  });

  it('renders a user_prompt event as a user block', () => {
    const rt = createRuntime();
    applyEvent(rt, userPrompt('hello'));
    const blocks = blocksOf(rt);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as Extract<FoldedBlock, { kind: 'event' }>).event).toMatchObject({
      type: 'user_prompt',
      text: 'hello',
    });
  });

  it('keeps tool calls separate and pairs the result to the right callId', () => {
    const rt = createRuntime();
    applyEvent(rt, toolReq('c1', 'grep', { q: 'foo' }));
    applyEvent(rt, toolReq('c2', 'write', { path: 'x' }));
    applyEvent(rt, toolRes('c1', true, ['hit']));
    const tools = blocksOf(rt).filter((b): b is Extract<FoldedBlock, { kind: 'tool-call' }> => b.kind === 'tool-call');
    expect(tools).toHaveLength(2);
    const c1 = tools.find((t) => t.request.callId === 'c1');
    const c2 = tools.find((t) => t.request.callId === 'c2');
    expect(c1!.outcome).toMatchObject({ type: 'tool_result', ok: true });
    expect(c2!.outcome).toBeNull();
  });

  it('carries tool_result error.message through', () => {
    const rt = createRuntime();
    applyEvent(rt, toolReq('c1', 'grep', {}));
    applyEvent(rt, toolRes('c1', false, undefined, { message: 'boom', kind: 'threw' }));
    const tool = blocksOf(rt).find((b): b is Extract<FoldedBlock, { kind: 'tool-call' }> => b.kind === 'tool-call');
    expect(tool!.outcome).toMatchObject({ type: 'tool_result', ok: false, error: { message: 'boom' } });
  });

  it('renders error events as an event block', () => {
    const rt = createRuntime();
    applyEvent(rt, errorEvent('runner crashed'));
    const blocks = blocksOf(rt);
    expect((blocks.at(-1) as Extract<FoldedBlock, { kind: 'event' }>).event).toMatchObject({
      type: 'error',
      message: 'runner crashed',
    });
  });

  it('commits trailing streamed text on turn_complete (provider never sealed it)', () => {
    const rt = createRuntime();
    applyAction(rt, { type: 'send_started', turnId: 'T1' });
    applyEvent(rt, chunk('partial'));
    applyAction(rt, { type: 'turn_complete', turnId: 'T1', error: null });
    expect(rt.streamingText).toBe('');
    expect(rt.sending).toBe(false);
    expect(rt.activeTurnId).toBeNull();
    const last = blocksOf(rt).at(-1) as Extract<FoldedBlock, { kind: 'event' }>;
    expect(last.event).toMatchObject({ type: 'assistant_message', content: 'partial' });
  });

  it('adds an error notice extension when turn_complete carries an error', () => {
    const rt = createRuntime();
    applyAction(rt, { type: 'send_started', turnId: 'T1' });
    applyAction(rt, { type: 'turn_complete', turnId: 'T1', error: 'rate limited' });
    expect(rt.extensions).toHaveLength(1);
    expect(rt.extensions[0]).toMatchObject({ kind: 'notice', tone: 'error', text: 'rate limited' });
  });

  it('clear() resets log, stream, extensions, and flags', () => {
    const rt = createRuntime();
    applyAction(rt, { type: 'send_started', turnId: 'T1' });
    applyEvent(rt, chunk('hi'));
    applyAction(rt, { type: 'action_result', commandName: 'info', argsLine: '', tone: 'info', text: 'x' });
    applyAction(rt, { type: 'clear' });
    expect(blocksOf(rt)).toEqual([]);
    expect(rt.extensions).toEqual([]);
    expect(rt.streamingText).toBe('');
    expect(rt.activeTurnId).toBeNull();
  });

  it('ignores bookkeeping events (provider_request etc.)', () => {
    const rt = createRuntime();
    const changed = applyEvent(rt, evt('provider_request', { provider: 'anthropic' }));
    expect(changed).toBe(false);
    expect(rt.log.length).toBe(0);
  });
});

describe('buildRenderNodes', () => {
  it('interleaves extension cards at their event-count anchor', () => {
    const rt = createRuntime();
    applyEvent(rt, userPrompt('first'));
    // anchor an action_result after 1 event
    applyAction(rt, { type: 'action_result', commandName: 'clear', argsLine: '', tone: 'info', text: '' });
    applyEvent(rt, assistant('second'));
    const nodes = buildRenderNodes(rt.log.toArray(), rt.extensions);
    expect(nodes.map((node) => node.kind)).toEqual(['block', 'ext', 'block']);
  });

  it('dismiss_block removes an extension', () => {
    const rt = createRuntime();
    applyAction(rt, { type: 'action_result', commandName: 'x', argsLine: '', tone: 'info', text: 'y' });
    const id = rt.extensions[0]!.id;
    const changed = applyAction(rt, { type: 'dismiss_block', blockId: id });
    expect(changed).toBe(true);
    expect(rt.extensions).toEqual([]);
  });
});
