import type { ContentBlock, ProviderMessage, ToolDef } from '@moxxy/sdk';
import { zodToJsonSchema } from '@moxxy/sdk';

type CacheControl = { type: 'ephemeral' };

export interface AnthropicMessageInput {
  role: 'user' | 'assistant';
  content: Array<AnthropicContentBlock>;
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: CacheControl }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: CacheControl;
    }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      cache_control?: CacheControl;
    };

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: unknown;
  cache_control?: CacheControl;
}

export interface ToAnthropicMessagesOptions {
  /**
   * Indices (into the input `messages` array) after which a prompt-cache
   * breakpoint should be placed. The marker lands on the last Anthropic
   * content block produced for that source message.
   */
  readonly cacheMessageIndices?: ReadonlySet<number>;
}

function markCache(block: AnthropicContentBlock | undefined): void {
  if (block) block.cache_control = { type: 'ephemeral' };
}

export function toAnthropicMessages(
  messages: ReadonlyArray<ProviderMessage>,
  opts: ToAnthropicMessagesOptions = {},
): {
  system: string | undefined;
  messages: AnthropicMessageInput[];
} {
  const cacheIdx = opts.cacheMessageIndices;
  let system: string | undefined;
  const out: AnthropicMessageInput[] = [];
  let pendingUserBlocks: AnthropicContentBlock[] | null = null;
  const flushUser = (): void => {
    if (pendingUserBlocks) {
      out.push({ role: 'user', content: pendingUserBlocks });
      pendingUserBlocks = null;
    }
  };

  messages.forEach((msg, i) => {
    const wantCache = cacheIdx?.has(i) ?? false;

    if (msg.role === 'system') {
      const textBlock = msg.content.find((c) => c.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        system = system ? `${system}\n\n${textBlock.text}` : textBlock.text;
      }
      return;
    }

    if (msg.role === 'user') {
      flushUser();
      const content = msg.content.map(toAnthropicBlock);
      if (wantCache) markCache(content[content.length - 1]);
      out.push({ role: 'user', content });
      return;
    }

    if (msg.role === 'assistant') {
      flushUser();
      const content = msg.content.map(toAnthropicBlock);
      if (wantCache) markCache(content[content.length - 1]);
      out.push({ role: 'assistant', content });
      return;
    }

    if (msg.role === 'tool_result') {
      // Tool results are merged into a user message with tool_result content blocks
      pendingUserBlocks ??= [];
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          pendingUserBlocks.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          });
        }
      }
      // Breakpoint after a tool-result source message lands on the last block
      // appended for it. Caching up to a mid-message block is valid (it just
      // defines the prefix boundary), so merging doesn't break this.
      if (wantCache) markCache(pendingUserBlocks[pendingUserBlocks.length - 1]);
    }
  });
  flushUser();
  return { system, messages: out };
}

function toAnthropicBlock(block: ContentBlock): AnthropicContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      };
    case 'audio':
      // Anthropic's Messages API does not accept native audio yet. Channels
      // are supposed to transcribe up-front when the active model lacks
      // `supportsAudio`; if an audio block reaches the translator anyway
      // (e.g. a resumed session originally captured on a different
      // provider), degrade to a text placeholder rather than throwing.
      return {
        type: 'text',
        text: `[audio attachment dropped: ${block.mediaType} not supported by this model]`,
      };
  }
}

export interface ToAnthropicToolsOptions {
  /** Place a cache breakpoint on the last tool, caching the whole tools array. */
  readonly cacheLast?: boolean;
}

export function toAnthropicTools(
  tools: ReadonlyArray<ToolDef>,
  opts: ToAnthropicToolsOptions = {},
): AnthropicToolDef[] {
  const out = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputJsonSchema ?? zodToJsonSchema(t.inputSchema),
  })) as AnthropicToolDef[];
  if (opts.cacheLast && out.length > 0) {
    out[out.length - 1]!.cache_control = { type: 'ephemeral' };
  }
  return out;
}
