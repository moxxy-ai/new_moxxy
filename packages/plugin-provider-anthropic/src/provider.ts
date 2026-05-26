import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  ModelDescriptor,
  ProviderEvent,
  ProviderRequest,
  StopReason,
} from '@moxxy/sdk';
import { toFriendlyError } from '@moxxy/sdk';
import { toAnthropicMessages, toAnthropicTools } from './translate.js';

export interface AnthropicProviderConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly defaultModel?: string;
  readonly client?: Anthropic;
}

export const anthropicModels: ReadonlyArray<ModelDescriptor> = [
  { id: 'claude-opus-4-7', contextWindow: 800_000, maxOutputTokens: 8000, supportsTools: true, supportsStreaming: true, supportsImages: true },
  { id: 'claude-sonnet-4-6', contextWindow: 200_000, maxOutputTokens: 8000, supportsTools: true, supportsStreaming: true, supportsImages: true },
  { id: 'claude-haiku-4-5-20251001', contextWindow: 200_000, maxOutputTokens: 8000, supportsTools: true, supportsStreaming: true, supportsImages: true },
];

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly models = anthropicModels;
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(config: AnthropicProviderConfig = {}) {
    this.client =
      config.client ??
      new Anthropic({
        apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-6';
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // Translate provider-neutral cache hints into Anthropic cache_control
    // markers. `tools`/`system` mark those session-stable regions; a
    // `{ messageIndex }` hint marks the end of that message (the rolling
    // prefix breakpoint). Anthropic honors at most 4 breakpoints.
    const hints = req.cacheHints ?? [];
    const cacheTools = hints.some((h) => h.target === 'tools');
    const cacheSystem = hints.some((h) => h.target === 'system');
    const cacheMessageIndices = new Set<number>();
    for (const h of hints) {
      if (typeof h.target === 'object') cacheMessageIndices.add(h.target.messageIndex);
    }

    const { system, messages } = toAnthropicMessages(req.messages, { cacheMessageIndices });
    const tools =
      req.tools && req.tools.length > 0
        ? toAnthropicTools(req.tools, { cacheLast: cacheTools })
        : undefined;
    // To carry cache_control the system prompt must be sent in block form.
    const systemParam =
      cacheSystem && system
        ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
        : system;
    const model = req.model || this.defaultModel;

    yield { type: 'message_start', model };

    let stream: AsyncIterable<unknown>;
    try {
      stream = this.client.messages.stream(
        {
          model,
          max_tokens: req.maxTokens ?? 4096,
          system: systemParam,
          messages,
          tools,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        } as Parameters<typeof this.client.messages.stream>[0],
        // Pass the AbortSignal into the SDK request options so cancelling
        // tears down the underlying HTTP request. Without this, Esc only
        // stopped our loop while the model kept generating upstream.
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      yield { type: 'error', ...toFriendlyError(err, { provider: 'anthropic' }) };
      return;
    }

    const pendingToolUses = new Map<string, { name: string; partial: string }>();
    // Anthropic's stream events carry a block `index` on every delta/stop;
    // we map that index to the tool_use id at content_block_start time so
    // parallel tool_use blocks route their deltas correctly. Without this,
    // we used to return the first key in `pendingToolUses` for every event,
    // causing two parallel blocks to overwrite each other's partial JSON.
    const blockIndexToId = new Map<number, string>();
    let stopReason: StopReason = 'end_turn';
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    try {
      for await (const event of stream as AsyncIterable<AnthropicStreamEvent>) {
        if (req.signal?.aborted) {
          yield { type: 'error', message: 'aborted', retryable: false };
          return;
        }
        switch (event.type) {
          case 'message_start': {
            // Anthropic reports cache hits/writes only on the message_start
            // usage block — `cache_read_input_tokens` (billed 0.1x) and
            // `cache_creation_input_tokens` (billed 1.25x). Capture them here
            // so the metering layer can prove cache savings; without this the
            // fields are silently dropped and cache wins are invisible.
            const u = event.message?.usage;
            usage = {
              inputTokens: u?.input_tokens ?? 0,
              outputTokens: u?.output_tokens ?? 0,
              ...(u?.cache_read_input_tokens !== undefined
                ? { cacheReadTokens: u.cache_read_input_tokens }
                : {}),
              ...(u?.cache_creation_input_tokens !== undefined
                ? { cacheCreationTokens: u.cache_creation_input_tokens }
                : {}),
            };
            break;
          }
          case 'content_block_start': {
            const block = event.content_block;
            if (block && block.type === 'tool_use') {
              pendingToolUses.set(block.id, { name: block.name, partial: '' });
              // Real Anthropic events carry `index` here; fall back to the
              // arrival ordinal when callers (e.g. test fakes) omit it.
              const idx = typeof event.index === 'number' ? event.index : blockIndexToId.size;
              blockIndexToId.set(idx, block.id);
              yield { type: 'tool_use_start', id: block.id, name: block.name };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (!delta) break;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'text_delta', delta: delta.text };
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const id = idOfBlock(event, blockIndexToId);
              if (id) {
                const t = pendingToolUses.get(id);
                if (t) {
                  t.partial += delta.partial_json;
                  yield { type: 'tool_use_delta', id, partialInput: delta.partial_json };
                }
              }
            }
            break;
          }
          case 'content_block_stop': {
            const id = idOfBlock(event, blockIndexToId);
            if (id) {
              const t = pendingToolUses.get(id);
              if (t) {
                let parsed: unknown = {};
                try {
                  parsed = t.partial ? JSON.parse(t.partial) : {};
                } catch {
                  parsed = { _rawPartial: t.partial };
                }
                yield { type: 'tool_use_end', id, input: parsed };
                pendingToolUses.delete(id);
                if (typeof event.index === 'number') blockIndexToId.delete(event.index);
              }
            }
            break;
          }
          case 'message_delta': {
            if (event.delta?.stop_reason) {
              stopReason = mapStopReason(event.delta.stop_reason);
            }
            if (event.usage) {
              // Preserve cache fields captured at message_start — the delta
              // usage only carries the final output_tokens count.
              usage = {
                ...usage,
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: event.usage.output_tokens ?? usage?.outputTokens ?? 0,
              };
            }
            break;
          }
          case 'message_stop':
            break;
        }
      }
    } catch (err) {
      yield { type: 'error', ...toFriendlyError(err, { provider: 'anthropic' }) };
      return;
    }

    yield { type: 'message_end', stopReason, usage };
  }

  async countTokens(req: Pick<ProviderRequest, 'model' | 'messages' | 'system' | 'tools'>): Promise<number> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const tools = req.tools && req.tools.length > 0 ? toAnthropicTools(req.tools) : undefined;
    try {
      const result = await (this.client.messages as unknown as { countTokens: (args: unknown) => Promise<{ input_tokens: number }> }).countTokens({
        model: req.model || this.defaultModel,
        system,
        messages,
        tools,
      });
      return result.input_tokens;
    } catch {
      const blob =
        (system ?? '') +
        messages.map((m) => JSON.stringify(m.content)).join('') +
        JSON.stringify(tools ?? []);
      return Math.ceil(blob.length / 4);
    }
  }
}

interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type: 'text' | 'tool_use'; id: string; name: string };
  index?: number;
  delta?: {
    type?: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
}

function idOfBlock(
  event: AnthropicStreamEvent,
  blockIndexToId: Map<number, string>,
): string | null {
  if (typeof event.index === 'number') {
    return blockIndexToId.get(event.index) ?? null;
  }
  // Fallback when `index` is missing (older SDKs / hand-rolled fakes): only
  // unambiguous when exactly one tool_use is pending; otherwise refuse to
  // guess and let the delta drop rather than misroute it.
  if (blockIndexToId.size === 1) {
    for (const id of blockIndexToId.values()) return id;
  }
  return null;
}

function mapStopReason(s: string): StopReason {
  if (s === 'tool_use') return 'tool_use';
  if (s === 'max_tokens') return 'max_tokens';
  if (s === 'stop_sequence') return 'stop_sequence';
  if (s === 'end_turn') return 'end_turn';
  return 'error';
}
