import { describe, expect, it, vi } from 'vitest';
import { CodexProvider } from './provider.js';
import { CODEX_RESPONSES_URL } from './oauth.js';
import type { CodexTokens } from './types.js';
import type { ProviderEvent, ProviderRequest } from '@moxxy/sdk';

function makeTokens(overrides: Partial<CodexTokens> = {}): CodexTokens {
  return {
    access: 'AT',
    refresh: 'RT',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'acct_test',
    ...overrides,
  };
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function baseRequest(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...over,
  };
}

describe('CodexProvider.stream', () => {
  it('sends Bearer auth, ChatGPT-Account-Id, originator and User-Agent headers', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(
        sseStream([
          'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":5}}}\n\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const provider = new CodexProvider({
      tokens: makeTokens(),
      fetch: fakeFetch as unknown as typeof fetch,
      sessionIdProvider: () => 'sess_fixed',
    });

    const events = await collect(provider.stream(baseRequest()));

    expect(captured.url).toBe(CODEX_RESPONSES_URL);
    expect(captured.init?.method).toBe('POST');
    const h = captured.init?.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer AT');
    expect(h['ChatGPT-Account-Id']).toBe('acct_test');
    expect(h['originator']).toBe('moxxy');
    expect(h['session_id']).toBe('sess_fixed');
    expect(h['User-Agent']).toMatch(/^moxxy\//);
    expect(h['Accept']).toBe('text/event-stream');

    // Event sequence: message_start, text_delta('hello'), message_end (with usage)
    expect(events[0]).toMatchObject({ type: 'message_start', model: 'gpt-5.3-codex' });
    expect(events.some((e) => e.type === 'text_delta' && e.delta === 'hello')).toBe(true);
    const end = events.find((e): e is Extract<ProviderEvent, { type: 'message_end' }> => e.type === 'message_end');
    expect(end?.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
    expect(end?.stopReason).toBe('end_turn');
  });

  it('omits ChatGPT-Account-Id when no accountId is set', async () => {
    const captured: { init?: RequestInit } = {};
    const fakeFetch = vi.fn(async (_u, init?: RequestInit) => {
      captured.init = init;
      return new Response(sseStream(['data: {"type":"response.completed"}\n\n']), {
        status: 200,
      });
    });
    const provider = new CodexProvider({
      tokens: makeTokens({ accountId: undefined }),
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await collect(provider.stream(baseRequest()));
    const h = captured.init?.headers as Record<string, string>;
    expect(h['ChatGPT-Account-Id']).toBeUndefined();
  });

  it('refreshes tokens proactively when expiry is within the 60s skew window, persists, then sends', async () => {
    const persisted: CodexTokens[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(sseStream(['data: {"type":"response.completed"}\n\n']), { status: 200 });
    });

    const provider = new CodexProvider({
      tokens: makeTokens({ expires: Date.now() + 10_000 }), // expires in 10s — within skew window
      onTokensRefreshed: async (next) => {
        persisted.push(next);
      },
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await collect(provider.stream(baseRequest()));

    // Token endpoint must be hit before the Codex API call.
    expect(calls[0]?.url).toContain('/oauth/token');
    expect(calls[1]?.url).toBe(CODEX_RESPONSES_URL);
    expect((calls[1]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer NEW_AT');

    // onTokensRefreshed was called BEFORE the codex call went out.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.access).toBe('NEW_AT');
    expect(persisted[0]!.refresh).toBe('NEW_RT');
    // accountId is preserved from the prior token bundle even though the
    // refresh response doesn't re-issue an id_token.
    expect(persisted[0]!.accountId).toBe('acct_test');
  });

  it('refreshes and replays once on a 401, then surfaces error on a second 401', async () => {
    let codexHits = 0;
    let refreshHits = 0;
    const fakeFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth/token')) {
        refreshHits++;
        return new Response(
          JSON.stringify({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      codexHits++;
      return new Response('unauthorized', { status: 401 });
    });

    const provider = new CodexProvider({
      tokens: makeTokens(),
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const events = await collect(provider.stream(baseRequest()));
    expect(refreshHits).toBe(1);
    expect(codexHits).toBe(2);
    expect(events.some((e) => e.type === 'error' && /401/.test(e.message))).toBe(true);
  });

  it('errors clearly when no tokens are configured', async () => {
    const provider = new CodexProvider({}); // no tokens
    const events = await collect(provider.stream(baseRequest()));
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toMatch(/moxxy login openai-codex/);
  });

  it('parses tool_use_start/delta/end from function_call SSE events', async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(
        sseStream([
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"Read"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"/tmp/x\\"}"}\n\n',
          'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"path\\":\\"/tmp/x\\"}"}\n\n',
          'data: {"type":"response.completed"}\n\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const provider = new CodexProvider({
      tokens: makeTokens(),
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const events = await collect(provider.stream(baseRequest()));

    const start = events.find((e) => e.type === 'tool_use_start');
    const end = events.find((e) => e.type === 'tool_use_end');
    expect(start).toMatchObject({ type: 'tool_use_start', id: 'call_abc', name: 'Read' });
    expect(end).toMatchObject({ type: 'tool_use_end', id: 'call_abc', input: { path: '/tmp/x' } });
    // Crucial regression guard: the Responses API's `response.completed`
    // doesn't carry a stop_reason, so the provider must infer 'tool_use'
    // from the emitted tool_use_end events. Without this, the upstream
    // tool-use loop drops the call without executing it.
    const messageEnd = events.find((e): e is Extract<ProviderEvent, { type: 'message_end' }> => e.type === 'message_end');
    expect(messageEnd?.stopReason).toBe('tool_use');
  });
});
