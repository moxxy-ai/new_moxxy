/**
 * End-to-end integration test. Boots a real HttpChannel on an ephemeral port
 * against a Session wired with FakeProvider + tool-use loop, then drives
 * actual HTTP requests via fetch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Session,
  autoAllowResolver,
  silentLogger,
} from '@moxxy/core';
import { defineProvider, definePlugin, defineTranscriber } from '@moxxy/sdk';
import { FakeProvider, textReply } from '@moxxy/testing';
import { toolUseLoopPlugin } from '@moxxy/loop-tool-use';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { HttpChannel } from './channel.js';
import type { ChannelHandle } from '@moxxy/sdk';

const TOKEN = 'test-token-123';

function buildSession(opts: { withTranscriber?: string } = {}): Session {
  const provider = new FakeProvider({
    script: [textReply('hello from the HTTP channel')],
  });
  const session = new Session({
    cwd: process.cwd(),
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  const plugins = [
    definePlugin({
      name: 'http-integration-shim',
      providers: [
        defineProvider({
          name: provider.name,
          models: [...provider.models],
          createClient: () => provider,
        }),
      ],
      ...(opts.withTranscriber !== undefined
        ? {
            transcribers: [
              defineTranscriber({
                name: 'fake-stt',
                createClient: () => ({
                  name: 'fake-stt',
                  transcribe: async () => ({ text: opts.withTranscriber! }),
                }),
              }),
            ],
          }
        : {}),
    }),
  ];
  for (const p of plugins) session.pluginHost.registerStatic(p);
  session.providers.setActive(provider.name);
  if (opts.withTranscriber !== undefined) session.transcribers.setActive('fake-stt');
  session.pluginHost.registerStatic(builtinToolsPlugin);
  session.pluginHost.registerStatic(toolUseLoopPlugin);
  return session;
}

async function pickPort(channel: HttpChannel): Promise<{ baseUrl: string; handle: ChannelHandle }> {
  // Use port 0 to let the OS assign a free port; HttpChannel ignores 0 and
  // uses its default. Override by passing a high random port instead.
  const port = 50000 + Math.floor(Math.random() * 10000);
  // Reconstruct with the chosen port.
  const real = new HttpChannel({
    port,
    host: '127.0.0.1',
    authToken: TOKEN,
    allowedTools: ['Read', 'Glob'],
  });
  Object.assign(channel, real);
  const handle = await channel.start({ session: buildSession() });
  return { baseUrl: `http://127.0.0.1:${port}`, handle };
}

let channel: HttpChannel;
let handle: ChannelHandle;
let baseUrl: string;

beforeEach(async () => {
  channel = new HttpChannel({
    port: 0,
    authToken: TOKEN,
    allowedTools: ['Read', 'Glob'],
  });
  const started = await pickPort(channel);
  baseUrl = started.baseUrl;
  handle = started.handle;
});

afterEach(async () => {
  await handle.stop();
});

describe('HttpChannel integration', () => {
  it('GET /v1/health returns 200 ok without auth', async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('POST /v1/turn rejects missing Bearer token with 401', async () => {
    const res = await fetch(`${baseUrl}/v1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/turn rejects wrong Bearer token with 401', async () => {
    const res = await fetch(`${baseUrl}/v1/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/turn rejects malformed body with 400', async () => {
    const res = await fetch(`${baseUrl}/v1/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: '{"not-prompt": 1}',
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/turn drives a full turn and returns events + assistant text', async () => {
    const res = await fetch(`${baseUrl}/v1/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ prompt: 'say hi' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }>; assistant: string };
    expect(body.assistant).toContain('hello from the HTTP channel');
    expect(body.events.some((e) => e.type === 'user_prompt')).toBe(true);
    expect(body.events.some((e) => e.type === 'assistant_message')).toBe(true);
  });

  it('POST /v1/turn/stream returns Server-Sent Events with [DONE] terminator', async () => {
    const res = await fetch(`${baseUrl}/v1/turn/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ prompt: 'say hi' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text).toMatch(/data: \[DONE\]\n\n$/);
    // Each event is a JSON object — find the user_prompt one
    const lines = text.split('\n\n').filter((l) => l.startsWith('data: '));
    const parsed = lines
      .map((l) => l.slice(6))
      .filter((s) => s !== '[DONE]')
      .map((s) => JSON.parse(s) as { type: string });
    expect(parsed.some((e) => e.type === 'user_prompt')).toBe(true);
    expect(parsed.some((e) => e.type === 'assistant_chunk')).toBe(true);
  });

  it('GET on an unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/nonsense`);
    expect(res.status).toBe(404);
  });
});

describe('HttpChannel /v1/turn/audio integration', () => {
  let audioChannel: HttpChannel;
  let audioHandle: ChannelHandle;
  let audioBaseUrl: string;

  beforeEach(async () => {
    audioChannel = new HttpChannel({
      port: 0,
      authToken: TOKEN,
      allowedTools: ['Read', 'Glob'],
    });
    const port = 50000 + Math.floor(Math.random() * 10000);
    const real = new HttpChannel({
      port,
      host: '127.0.0.1',
      authToken: TOKEN,
      allowedTools: ['Read', 'Glob'],
    });
    Object.assign(audioChannel, real);
    audioHandle = await audioChannel.start({
      session: buildSession({ withTranscriber: 'transcribed voice content' }),
    });
    audioBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await audioHandle.stop();
  });

  it('POST /v1/turn/audio transcribes the body and runs a full turn', async () => {
    const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    const res = await fetch(`${audioBaseUrl}/v1/turn/audio`, {
      method: 'POST',
      headers: {
        'content-type': 'audio/ogg',
        authorization: `Bearer ${TOKEN}`,
      },
      body: oggBytes,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      transcript: string;
      assistant: string;
      events: Array<{ type: string }>;
    };
    expect(body.transcript).toBe('transcribed voice content');
    expect(body.assistant).toContain('hello from the HTTP channel');
    expect(body.events.some((e) => e.type === 'user_prompt')).toBe(true);
    expect(body.events.some((e) => e.type === 'assistant_message')).toBe(true);
  });

  it('POST /v1/turn/audio rejects non-audio Content-Type with 415', async () => {
    const res = await fetch(`${audioBaseUrl}/v1/turn/audio`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: 'bytes',
    });
    expect(res.status).toBe(415);
  });
});

describe('HttpChannel auth-disabled mode', () => {
  it('without authToken, /v1/turn does not require Bearer header', async () => {
    const open = new HttpChannel({
      port: 0,
      allowedTools: ['Read'],
    });
    const port = 50000 + Math.floor(Math.random() * 10000);
    const real = new HttpChannel({ port, allowedTools: ['Read'] });
    Object.assign(open, real);
    const openHandle = await open.start({ session: buildSession() });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await openHandle.stop();
    }
  });
});
