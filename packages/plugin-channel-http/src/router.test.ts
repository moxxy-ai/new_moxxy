import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { Socket } from 'node:net';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin, defineProvider, defineTranscriber } from '@moxxy/sdk';
import {
  routeRequest,
  handleHealth,
  handleRunCommand,
  handleTurnAudio,
  turnRequestSchema,
} from './router.js';

function makeIncoming(opts: { method: string; url: string; headers?: Record<string, string>; body?: string }): IncomingMessage {
  const readable = Readable.from(opts.body ? [Buffer.from(opts.body)] : []);
  const socket = new Socket();
  const req = readable as unknown as IncomingMessage;
  Object.assign(req, {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    socket,
  });
  return req;
}

function makeResponse(): ServerResponse & {
  _status: number;
  _headers: Record<string, string | number | string[]>;
  _body: string;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string | number | string[]>,
    _body: '',
    headersSent: false,
    writeHead(status: number, headers: Record<string, string | number | string[]>) {
      this._status = status;
      this._headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body?: string) {
      if (body !== undefined) this._body += body;
      return this;
    },
    write(chunk: string) {
      this._body += chunk;
      return true;
    },
  } as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string | number | string[]>;
    _body: string;
  };
  return res;
}

describe('routeRequest', () => {
  it('matches GET /v1/health', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/v1/health' }))).toBe(handleHealth);
  });

  it('returns null for unknown routes', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/unknown' }))).toBeNull();
    expect(routeRequest(makeIncoming({ method: 'PUT', url: '/v1/turn' }))).toBeNull();
  });

  it('matches POST /v1/turn', () => {
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/turn' }))).not.toBeNull();
  });

  it('matches POST /v1/turn/stream', () => {
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/turn/stream' }))).not.toBeNull();
  });

  it('matches POST /v1/turn/audio (with or without query string)', () => {
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/turn/audio' }))).toBe(
      handleTurnAudio,
    );
    expect(
      routeRequest(makeIncoming({ method: 'POST', url: '/v1/turn/audio?model=sonnet' })),
    ).toBe(handleTurnAudio);
  });
});

describe('handleTurnAudio', () => {
  const ctx = (session: Session) => ({ session, authToken: 'x', logger: silentLogger });

  it('rejects requests without Bearer auth with 401', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    const res = makeResponse();
    await handleTurnAudio(
      makeIncoming({ method: 'POST', url: '/v1/turn/audio', headers: { 'content-type': 'audio/ogg' } }),
      res,
      ctx(session),
    );
    expect(res._status).toBe(401);
  });

  it('returns 503 when no transcriber is active on the session', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    const res = makeResponse();
    await handleTurnAudio(
      makeIncoming({
        method: 'POST',
        url: '/v1/turn/audio',
        headers: { 'content-type': 'audio/ogg', authorization: 'Bearer x' },
        body: 'oggbytes',
      }),
      res,
      ctx(session),
    );
    expect(res._status).toBe(503);
    expect(JSON.parse(res._body).error).toBe('no_transcriber');
  });

  it('rejects non-audio Content-Type with 415', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    session.transcribers.register(
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe: async () => ({ text: 'x' }) }),
      }),
    );
    session.transcribers.setActive('t');
    const res = makeResponse();
    await handleTurnAudio(
      makeIncoming({
        method: 'POST',
        url: '/v1/turn/audio',
        headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer x' },
        body: 'bytes',
      }),
      res,
      ctx(session),
    );
    expect(res._status).toBe(415);
  });

  it('returns 400 on empty body', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    session.transcribers.register(
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe: async () => ({ text: 'x' }) }),
      }),
    );
    session.transcribers.setActive('t');
    const res = makeResponse();
    await handleTurnAudio(
      makeIncoming({
        method: 'POST',
        url: '/v1/turn/audio',
        headers: { 'content-type': 'audio/ogg', authorization: 'Bearer x' },
        body: '',
      }),
      res,
      ctx(session),
    );
    expect(res._status).toBe(400);
  });

  it('returns 422 when the transcriber yields an empty transcript', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    session.transcribers.register(
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe: async () => ({ text: '   ' }) }),
      }),
    );
    session.transcribers.setActive('t');
    const res = makeResponse();
    await handleTurnAudio(
      makeIncoming({
        method: 'POST',
        url: '/v1/turn/audio',
        headers: { 'content-type': 'audio/ogg', authorization: 'Bearer x' },
        body: 'oggbytes',
      }),
      res,
      ctx(session),
    );
    expect(res._status).toBe(422);
  });
});

describe('handleHealth', () => {
  it('replies 200 ok', async () => {
    const res = makeResponse();
    await handleHealth(makeIncoming({ method: 'GET', url: '/v1/health' }), res);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ status: 'ok' });
  });
});

describe('handleRunCommand', () => {
  it('emits a global command session_action event for /new on the main session', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    await session.log.append({
      type: 'user_prompt',
      sessionId: session.id,
      turnId: session.startTurn().turnId,
      source: 'user',
      text: 'old conversation',
    });

    const res = makeResponse();
    await handleRunCommand(
      makeIncoming({
        method: 'POST',
        url: '/v1/commands',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          agent_id: 'session',
          command: '/new',
          origin_id: 'office-client-1',
        }),
      }),
      res,
      { session, authToken: 'x', logger: silentLogger },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({
      kind: 'client_action',
      action: 'reset_session',
      agent_id: 'session',
    });
    expect(session.log.toJSON()).toHaveLength(1);
    expect(session.log.ofType('plugin_event')[0]).toMatchObject({
      subtype: 'command.session_action',
      payload: {
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'office',
        origin_id: 'office-client-1',
      },
    });
  });

  it('does not treat /new as an Office Agent local reset', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    const res = makeResponse();
    await handleRunCommand(
      makeIncoming({
        method: 'POST',
        url: '/v1/commands',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          agent_id: 'office-agent-0001',
          command: '/new',
          origin_id: 'office-client-1',
        }),
      }),
      res,
      { session, authToken: 'x', logger: silentLogger },
    );

    expect(res._status).toBe(409);
    expect(JSON.parse(res._body)).toMatchObject({
      error: 'unsupported',
    });
    expect(session.log.ofType('plugin_event')).toHaveLength(0);
  });

  it('keeps /clear local without emitting a command sync event', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    const res = makeResponse();
    await handleRunCommand(
      makeIncoming({
        method: 'POST',
        url: '/v1/commands',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          agent_id: 'session',
          command: '/clear',
          origin_id: 'office-client-1',
        }),
      }),
      res,
      { session, authToken: 'x', logger: silentLogger },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({
      kind: 'client_action',
      action: 'clear_agent_timeline',
      agent_id: 'session',
    });
    expect(session.log.ofType('plugin_event')).toHaveLength(0);
  });

  it('emits command state_changed when Office switches the model', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'router-test-provider',
        providers: [
          defineProvider({
            name: 'fake',
            models: [{ id: 'fake-model' }],
            createClient: () => ({}) as never,
          }),
        ],
      }),
    );
    session.providers.setActive('fake');

    const res = makeResponse();
    await handleRunCommand(
      makeIncoming({
        method: 'POST',
        url: '/v1/commands',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          agent_id: 'session',
          command: '/model fake-model',
          origin_id: 'office-client-1',
        }),
      }),
      res,
      { session, authToken: 'x', logger: silentLogger },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      kind: 'notice',
      message: 'switched to fake::fake-model',
    });
    expect(session.log.ofType('plugin_event')[0]).toMatchObject({
      subtype: 'command.state_changed',
      payload: {
        command: '/model fake::fake-model',
        action: 'model_changed',
        target: 'session',
        origin_channel: 'office',
        origin_id: 'office-client-1',
        provider: 'fake',
        model: 'fake-model',
      },
    });
  });
});

describe('turnRequestSchema', () => {
  it('accepts minimal {prompt}', () => {
    expect(turnRequestSchema.parse({ prompt: 'hi' })).toEqual({ prompt: 'hi' });
  });

  it('accepts optional model + systemPrompt', () => {
    const out = turnRequestSchema.parse({ prompt: 'hi', model: 'sonnet', systemPrompt: 'be terse' });
    expect(out.model).toBe('sonnet');
    expect(out.systemPrompt).toBe('be terse');
  });

  it('rejects empty prompt', () => {
    expect(() => turnRequestSchema.parse({ prompt: '' })).toThrow();
  });

  it('rejects non-string fields', () => {
    expect(() => turnRequestSchema.parse({ prompt: 123 })).toThrow();
  });
});

// keep `vi` reachable so the import isn't pruned by some bundlers in CI
void vi;
