import OpenAI from 'openai';
import type {
  LLMProvider,
  ModelDescriptor,
  ProviderEvent,
  ProviderRequest,
  StopReason,
} from '@moxxy/sdk';
import { isRetryableError } from '@moxxy/sdk';
import { toOpenAIMessages, toOpenAITools } from './translate.js';

export interface OpenAIProviderConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly defaultModel?: string;
  readonly client?: OpenAI;
}

/**
 * Model catalog as of OpenAI's 2026 API surface. The 5.x family supersedes
 * the 4o family but the older ones stay listed so existing configs keep
 * working without a forced migration.
 *
 * Output/context numbers are the public documented limits as of April-May
 * 2026; verify against https://developers.openai.com/api/docs/models when
 * picking a model for a long-context workload.
 */
export const openAIModels: ReadonlyArray<ModelDescriptor> = [
  // GPT-5.5 family (released April 23, 2026): newest frontier class.
  { id: 'gpt-5.5', contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-5.5-pro', contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },

  // GPT-5.4 family: cheaper general-purpose tier; -mini and -nano are the
  // new sweet-spot defaults for high-volume agentic workloads.
  { id: 'gpt-5.4', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-5.4-pro', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-5.4-mini', contextWindow: 400_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-5.4-nano', contextWindow: 400_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },

  // GPT-5.3-Codex: agentic coding specialist.
  { id: 'gpt-5.3-codex', contextWindow: 400_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },

  // GPT-5.2 and GPT-5: prior reasoning models, configurable effort.
  { id: 'gpt-5.2', contextWindow: 400_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-5', contextWindow: 400_000, maxOutputTokens: 128_000, supportsTools: true, supportsStreaming: true },

  // GPT-4 family: kept for explicit-pin use cases.
  { id: 'gpt-4.1', contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-4o', contextWindow: 128_000, maxOutputTokens: 16_384, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-4o-mini', contextWindow: 128_000, maxOutputTokens: 16_384, supportsTools: true, supportsStreaming: true },
  { id: 'gpt-4-turbo', contextWindow: 128_000, maxOutputTokens: 4_096, supportsTools: true, supportsStreaming: true },
];

interface PendingToolCall {
  id: string;
  name: string;
  argsBuffer: string;
  emittedStart: boolean;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly models = openAIModels;
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(config: OpenAIProviderConfig = {}) {
    this.client =
      config.client ??
      new OpenAI({
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
    this.defaultModel = config.defaultModel ?? 'gpt-5.4-mini';
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages = toOpenAIMessages(req.messages);
    const tools = req.tools && req.tools.length > 0 ? toOpenAITools(req.tools) : undefined;
    const model = req.model || this.defaultModel;

    yield { type: 'message_start', model };

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await this.client.chat.completions.create({
        model,
        messages: messages as never,
        ...(tools ? { tools: tools as never } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        stream: true,
      })) as unknown as AsyncIterable<unknown>;
    } catch (err) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: isRetryableError(err),
      };
      return;
    }

    const pending = new Map<number, PendingToolCall>();
    let stopReason: StopReason = 'end_turn';
    let usageIn = 0;
    let usageOut = 0;

    try {
      for await (const raw of stream as AsyncIterable<OpenAIStreamChunk>) {
        if (req.signal?.aborted) {
          yield { type: 'error', message: 'aborted', retryable: false };
          return;
        }
        const choice = raw.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text_delta', delta: delta.content };
        }

        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index ?? 0;
            let entry = pending.get(idx);
            if (!entry) {
              entry = {
                id: tcDelta.id ?? `call_${idx}`,
                name: tcDelta.function?.name ?? '',
                argsBuffer: '',
                emittedStart: false,
              };
              pending.set(idx, entry);
            } else if (tcDelta.id) {
              entry.id = tcDelta.id;
            }
            if (tcDelta.function?.name && !entry.name) entry.name = tcDelta.function.name;
            if (tcDelta.function?.name && !entry.emittedStart && entry.name) {
              entry.emittedStart = true;
              yield { type: 'tool_use_start', id: entry.id, name: entry.name };
            }
            if (typeof tcDelta.function?.arguments === 'string') {
              entry.argsBuffer += tcDelta.function.arguments;
              yield { type: 'tool_use_delta', id: entry.id, partialInput: tcDelta.function.arguments };
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }

        if (raw.usage) {
          usageIn = raw.usage.prompt_tokens ?? usageIn;
          usageOut = raw.usage.completion_tokens ?? usageOut;
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: isRetryableError(err),
      };
      return;
    }

    // Flush tool_use_end events with parsed arguments.
    for (const entry of pending.values()) {
      let parsed: unknown = {};
      if (entry.argsBuffer) {
        try {
          parsed = JSON.parse(entry.argsBuffer);
        } catch {
          parsed = { _rawPartial: entry.argsBuffer };
        }
      }
      if (entry.emittedStart) {
        yield { type: 'tool_use_end', id: entry.id, input: parsed };
      }
    }

    yield {
      type: 'message_end',
      stopReason,
      usage: usageIn > 0 || usageOut > 0 ? { inputTokens: usageIn, outputTokens: usageOut } : undefined,
    };
  }

  async countTokens(req: Pick<ProviderRequest, 'model' | 'messages' | 'system' | 'tools'>): Promise<number> {
    // OpenAI doesn't expose a free token counter; fall back to a coarse estimate.
    const blob =
      (req.system ?? '') +
      req.messages.map((m) => m.content.map((c) => ('text' in c ? c.text : JSON.stringify(c))).join('')).join('') +
      (req.tools ?? []).map((t) => t.name + t.description).join('');
    return Math.ceil(blob.length / 4);
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function mapStopReason(s: string): StopReason {
  if (s === 'tool_calls') return 'tool_use';
  if (s === 'length') return 'max_tokens';
  if (s === 'stop') return 'end_turn';
  if (s === 'content_filter') return 'error';
  return 'end_turn';
}
