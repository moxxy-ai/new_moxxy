import { webcrypto } from 'node:crypto';
import type {
  LLMProvider,
  ProviderEvent,
  ProviderRequest,
} from '@moxxy/sdk';
import { CODEX_RESPONSES_URL, refreshTokens } from './oauth.js';
import { codexModels, DEFAULT_CODEX_MODEL } from './models.js';
import { toResponsesBody } from './translate.js';
import { buildCodexHeaders } from './codex/headers.js';
import { consumeResponsesSse, toErrorEvent } from './codex/stream-consumer.js';
import type { CodexTokens } from './types.js';

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
      yield toErrorEvent(err);
      return;
    }

    const body = toResponsesBody({ ...req, model });
    const sessionId = this.sessionIdProvider();

    let response: Response;
    try {
      response = await this.postCodex(body, sessionId, req.signal);
    } catch (err) {
      yield toErrorEvent(err);
      return;
    }

    if (response.status === 401) {
      // Token might've been revoked between our pre-check and send; try one
      // forced refresh and replay. A second 401 is fatal.
      try {
        await this.refreshNow();
        response = await this.postCodex(body, sessionId, req.signal);
      } catch (err) {
        yield toErrorEvent(err);
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

    yield* consumeResponsesSse(response.body, req.signal);
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

  private postCodex(body: unknown, sessionId: string, signal: AbortSignal | undefined): Promise<Response> {
    if (!this.tokens) throw new Error('No tokens');
    return this.fetchImpl(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: buildCodexHeaders(this.tokens, sessionId),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
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
}
