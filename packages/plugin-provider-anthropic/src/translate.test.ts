import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@moxxy/sdk';
import { toAnthropicMessages, toAnthropicTools } from './translate.js';

describe('toAnthropicMessages', () => {
  it('hoists system messages', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: [{ type: 'text', text: 'you are X' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(system).toBe('you are X');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('translates assistant tool_use blocks', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a' } }],
      },
    ]);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'Read' });
  });

  it('merges adjacent tool_result messages into a user message', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'T', input: {} }] },
      {
        role: 'tool_result',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok', isError: false }],
      },
    ]);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'ok',
    });
  });

  it('places cache_control on the last block of a hinted message', () => {
    const { messages } = toAnthropicMessages(
      [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
        { role: 'user', content: [{ type: 'text', text: 'c' }] },
      ],
      { cacheMessageIndices: new Set([2]) },
    );
    const marked = messages[messages.length - 1]!.content[0]!;
    expect(marked.cache_control).toEqual({ type: 'ephemeral' });
    // Unhinted messages stay unmarked.
    expect(messages[0]!.content[0]!.cache_control).toBeUndefined();
  });

  it('adds no cache_control when no hints are given', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
    ]);
    expect(messages[0]!.content[0]!.cache_control).toBeUndefined();
  });
});

describe('toAnthropicTools', () => {
  it('emits name + description + json schema', () => {
    const tool = defineTool({
      name: 'Greet',
      description: 'Greet someone',
      inputSchema: z.object({ name: z.string() }),
      handler: () => null,
    });
    const out = toAnthropicTools([tool]);
    expect(out[0].name).toBe('Greet');
    expect(out[0].description).toBe('Greet someone');
    const schema = out[0].input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
  });

  it('marks the last tool with cache_control when cacheLast is set', () => {
    const mk = (name: string) =>
      defineTool({ name, description: name, inputSchema: z.object({}), handler: () => null });
    const out = toAnthropicTools([mk('A'), mk('B')], { cacheLast: true });
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});
