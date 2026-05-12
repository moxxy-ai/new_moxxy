import { webcrypto } from 'node:crypto';
import {
  isRetryableError,
  type LLMProvider,
  type ProviderEvent,
  type ProviderRequest,
  type StopReason,
} from '@moxxy/sdk';
import { CODEX_RESPONSES_URL, ORIGINATOR, refreshTokens } from './oauth.js';
import { codexModels, DEFAULT_CODEX_MODEL } from './models.js';
import { toResponsesBody } from './translate.js';
import type { CodexTokens } from './types.js';

const CODEX_USER_AGENT = `moxxy/0.0.0 (codex)`;

export interface CodexProviderConfig {
  readonly tokens?: CodexTokens;
  /**
   * Called with the new token bundle whenever an in-process refresh happens.
   * The CLI's setup wires this to a vault writeback so the refreshed
   * refresh_token (single-use, rotates on every refresh) is persisted
   * before the next API call goes out.
   */
  readonly onTokensRefreshed?: (next: CodexTokens) => void | Promise<void>;
  readonly defaultModel?: string;
  /** Test seam — when omitted we use the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam — when omitted we use crypto.randomUUID for the per-request session id. */
  readonly sessionIdProvider?: () => string;
}

interface PendingFunctionCall {
  id: string;
  callId: string;
  name: string;
  args: string;
  emittedStart: boolean;
}

/**
 * LLMProvider implementation against the ChatGPT-plan Codex backend. Auth is
 * an OAuth bearer plus the optional ChatGPT-Account-Id header; the rest of
 * the request body is the OpenAI Responses-API shape.
 */
export class CodexProvider implements LLMProvider {
  readonly name = 'openai-codex';
  readonly models = codexModels;

  private tokens: CodexTokens | undefined;
  private readonly onTokensRefreshed?: (next: CodexTokens) => void | Promise<void>;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sessionIdProvider: () => string;

  constructor(config: CodexProviderConfig = {}) {
    if (config.tokens) this.tokens = config.tokens;
    if (config.onTokensRefreshed) this.onTokensRefreshed = config.onTokensRefreshed;
    this.defaultModel = config.defaultModel ?? DEFAULT_CODEX_MODEL;
    this.fetchImpl = config.fetch ?? fetch;
    this.sessionIdProvider = config.sessionIdProvider ?? (() => webcrypto.randomUUID());
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || this.defaultModel;
    yield { type: 'message_start', model };

    try {
      await this.ensureFresh();
    } catch (err) {
      yield this.toErrorEvent(err);
      return;
    }

    const body = toResponsesBody({ ...req, model });
    const sessionId = this.sessionIdProvider();

    let response: Response;
    try {
      response = await this.fetchImpl(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: this.buildHeaders(sessionId),
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      yield this.toErrorEvent(err);
      return;
    }

    if (response.status === 401) {
      // Token might've been revoked between our pre-check and send; try one
      // forced refresh and replay. A second 401 is fatal.
      try {
        await this.refreshNow();
        response = await this.fetchImpl(CODEX_RESPONSES_URL, {
          method: 'POST',
          headers: this.buildHeaders(sessionId),
          body: JSON.stringify(body),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (err) {
        yield this.toErrorEvent(err);
        return;
      }
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      yield {
        type: 'error',
        message: `Codex /responses returned ${response.status}: ${text || response.statusText}`,
        retryable: response.status >= 500 || response.status === 429,
      };
      return;
    }

    yield* this.consumeSse(response.body, req.signal);
  }

  async countTokens(
    req: Pick<ProviderRequest, 'model' | 'messages' | 'system' | 'tools'>,
  ): Promise<number> {
    const blob =
      (req.system ?? '') +
      req.messages
        .map((m) => m.content.map((c) => ('text' in c ? c.text : JSON.stringify(c))).join(''))
        .join('') +
      (req.tools ?? []).map((t) => t.name + t.description).join('');
    return Math.ceil(blob.length / 4);
  }

  private async ensureFresh(): Promise<void> {
    if (!this.tokens) {
      throw new Error(
        'No ChatGPT OAuth credentials available. Run `moxxy login openai-codex` to sign in.',
      );
    }
    // 60s skew window — refresh proactively if the token will die very soon.
    if (this.tokens.expires > Date.now() + 60_000) return;
    await this.refreshNow();
  }

  private async refreshNow(): Promise<void> {
    if (!this.tokens) {
      throw new Error('Cannot refresh — no stored tokens.');
    }
    const next = await refreshTokens(this.tokens.refresh, this.fetchImpl);
    // Preserve a previously known accountId if the refresh response didn't
    // re-issue an id_token. Without this we'd silently lose the
    // ChatGPT-Account-Id header on every refresh.
    const accountId = next.accountId ?? this.tokens.accountId;
    const merged: CodexTokens = accountId
      ? { access: next.access, refresh: next.refresh, expires: next.expires, accountId }
      : { access: next.access, refresh: next.refresh, expires: next.expires };
    this.tokens = merged;
    if (this.onTokensRefreshed) {
      // Persist BEFORE the caller issues the API call so a crash here
      // doesn't strand an unwritten refresh token in memory.
      await this.onTokensRefreshed(merged);
    }
  }

  private buildHeaders(sessionId: string): Record<string, string> {
    if (!this.tokens) throw new Error('No tokens');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.tokens.access}`,
      originator: ORIGINATOR,
      'User-Agent': CODEX_USER_AGENT,
      session_id: sessionId,
    };
    if (this.tokens.accountId) headers['ChatGPT-Account-Id'] = this.tokens.accountId;
    return headers;
  }

  private toErrorEvent(err: unknown): ProviderEvent {
    return {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      retryable: isRetryableError(err),
    };
  }

  private async *consumeSse(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
  ): AsyncIterable<ProviderEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const pending = new Map<string, PendingFunctionCall>();
    let stopReason: StopReason = 'end_turn';
    let usageIn = 0;
    let usageOut = 0;
    let sawTerminalEvent = false;

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: 'error', message: 'aborted', retryable: false };
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines (\n\n). Some servers emit
        // \r\n\r\n; normalize first.
        buffer = buffer.replace(/\r\n/g, '\n');

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trimStart();
            if (!payload || payload === '[DONE]') continue;

            let json: ResponsesSseEvent;
            try {
              json = JSON.parse(payload) as ResponsesSseEvent;
            } catch {
              continue;
            }
            const result = handleSseEvent(json, pending);
            if (result.events) for (const ev of result.events) yield ev;
            if (result.stopReason) stopReason = result.stopReason;
            if (result.usage) {
              usageIn = result.usage.input ?? usageIn;
              usageOut = result.usage.output ?? usageOut;
            }
            if (result.terminal) sawTerminalEvent = true;
          }
        }
      }
    } catch (err) {
      yield this.toErrorEvent(err);
      return;
    }

    // Flush any tool_call_end events that didn't have a matching .done frame
    // (defensive — the server normally sends function_call.done, but a
    // truncated stream shouldn't drop the entire tool-use sequence).
    for (const entry of pending.values()) {
      if (entry.emittedStart) {
        let input: unknown = {};
        if (entry.args) {
          try {
            input = JSON.parse(entry.args);
          } catch {
            input = { _rawPartial: entry.args };
          }
        }
        yield { type: 'tool_use_end', id: entry.callId || entry.id, input };
      }
    }

    if (!sawTerminalEvent && stopReason === 'end_turn' && pending.size > 0) {
      stopReason = 'tool_use';
    }

    yield {
      type: 'message_end',
      stopReason,
      ...(usageIn > 0 || usageOut > 0
        ? { usage: { inputTokens: usageIn, outputTokens: usageOut } }
        : {}),
    };
  }
}

interface ResponsesSseEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  error?: { message?: string };
}

interface SseStepResult {
  events?: ProviderEvent[];
  stopReason?: StopReason;
  usage?: { input?: number; output?: number };
  terminal?: boolean;
}

/**
 * Map a single Responses-API SSE event to zero or more moxxy ProviderEvents.
 * Centralized here so the streaming loop stays a thin "read frame → call
 * this → yield" structure and the event taxonomy is easy to test directly.
 *
 * Events we care about (subset of the full Responses API surface):
 *   response.output_text.delta         → text_delta
 *   response.output_item.added         → tool_use_start (if it's a function_call)
 *   response.function_call_arguments.delta → tool_use_delta
 *   response.function_call_arguments.done  → finalize tool_use_end
 *   response.completed                 → message_end (sets stopReason)
 *   response.failed / response.error   → error
 */
function handleSseEvent(
  ev: ResponsesSseEvent,
  pending: Map<string, PendingFunctionCall>,
): SseStepResult {
  const type = ev.type ?? '';

  if (type === 'response.output_text.delta' && typeof ev.delta === 'string' && ev.delta) {
    return { events: [{ type: 'text_delta', delta: ev.delta }] };
  }

  if (type === 'response.output_item.added' && ev.item?.type === 'function_call') {
    const id = ev.item.id ?? ev.item.call_id ?? `call_${pending.size}`;
    const callId = ev.item.call_id ?? id;
    const name = ev.item.name ?? '';
    const entry: PendingFunctionCall = {
      id,
      callId,
      name,
      args: ev.item.arguments ?? '',
      emittedStart: false,
    };
    pending.set(id, entry);
    if (name) {
      entry.emittedStart = true;
      return { events: [{ type: 'tool_use_start', id: callId, name }] };
    }
    return {};
  }

  if (type === 'response.function_call_arguments.delta') {
    const id = ev.item_id ?? ev.call_id ?? '';
    const entry = pending.get(id);
    const delta = ev.delta ?? '';
    if (entry && typeof delta === 'string') {
      entry.args += delta;
      const outId = entry.callId || entry.id;
      // If we hadn't emitted tool_use_start yet (server sent the args
      // before the item.added with a name), do so now using whatever
      // name landed later. Defensive — opencode's pattern.
      const startEvents: ProviderEvent[] = [];
      if (!entry.emittedStart && entry.name) {
        entry.emittedStart = true;
        startEvents.push({ type: 'tool_use_start', id: outId, name: entry.name });
      }
      return {
        events: [...startEvents, { type: 'tool_use_delta', id: outId, partialInput: delta }],
      };
    }
    return {};
  }

  if (type === 'response.function_call_arguments.done') {
    const id = ev.item_id ?? ev.call_id ?? '';
    const entry = pending.get(id);
    if (!entry) return {};
    pending.delete(id);
    if (typeof ev.arguments === 'string' && ev.arguments) entry.args = ev.arguments;
    let input: unknown = {};
    if (entry.args) {
      try {
        input = JSON.parse(entry.args);
      } catch {
        input = { _rawPartial: entry.args };
      }
    }
    const outId = entry.callId || entry.id;
    const events: ProviderEvent[] = [];
    if (!entry.emittedStart && entry.name) {
      events.push({ type: 'tool_use_start', id: outId, name: entry.name });
    }
    events.push({ type: 'tool_use_end', id: outId, input });
    return { events };
  }

  if (type === 'response.completed') {
    const usage = ev.response?.usage;
    const incomplete = ev.response?.incomplete_details?.reason;
    let stopReason: StopReason = 'end_turn';
    if (incomplete === 'max_output_tokens') stopReason = 'max_tokens';
    else if (incomplete === 'stop_sequence') stopReason = 'stop_sequence';
    // The presence of unflushed function calls would already get mapped to
    // tool_use by the post-loop logic; the explicit "completed" event
    // doesn't carry a tool_use stop reason on its own.
    return {
      stopReason,
      ...(usage
        ? { usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } }
        : {}),
      terminal: true,
    };
  }

  if (type === 'response.failed' || type === 'response.error' || type === 'error') {
    const msg = ev.error?.message ?? `Codex stream failed: ${type}`;
    return { events: [{ type: 'error', message: msg, retryable: false }], terminal: true };
  }

  return {};
}
