/**
 * End-to-end integration test. Boots a real HttpChannel on an ephemeral port
 * against a Session wired with FakeProvider + tool-use loop, then drives
 * actual HTTP requests via fetch.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Session,
  autoAllowResolver,
  silentLogger,
} from '@moxxy/core';
import { defineProvider, definePlugin, defineTranscriber, type CommandDef } from '@moxxy/sdk';
import { FakeProvider, textReply } from '@moxxy/testing';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
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
  const commands: CommandDef[] = [
    {
      name: 'info',
      description: 'Show session info',
      handler: () => ({ kind: 'text', text: 'session info from command registry' }),
    },
    {
      name: 'clear',
      description: 'Clear scrollback',
      handler: () => ({ kind: 'session-action', action: 'clear', notice: 'scrollback cleared' }),
    },
    {
      name: 'new',
      description: 'Start a new chat',
      handler: () => ({ kind: 'session-action', action: 'new', notice: 'new chat started' }),
    },
    {
      name: 'compact',
      description: 'Compact context',
      handler: () => ({ kind: 'text', text: 'compacted test context' }),
    },
    {
      name: 'exit',
      description: 'Quit the channel',
      aliases: ['quit', 'q'],
      handler: () => ({ kind: 'session-action', action: 'exit' }),
    },
    {
      name: 'help',
      description: 'List commands',
      handler: () => ({ kind: 'text', text: 'help text' }),
    },
  ];
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
      commands,
    }),
  ];
  for (const p of plugins) session.pluginHost.registerStatic(p);
  session.providers.setActive(provider.name);
  if (opts.withTranscriber !== undefined) session.transcribers.setActive('fake-stt');
  session.pluginHost.registerStatic(builtinToolsPlugin);
  session.pluginHost.registerStatic(toolUseModePlugin);
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
let previousMoxxyHome: string | undefined;
const tempDirs: string[] = [];

beforeEach(async () => {
  previousMoxxyHome = process.env.MOXXY_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-http-integration-'));
  tempDirs.push(home);
  process.env.MOXXY_HOME = home;
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
  if (previousMoxxyHome === undefined) {
    delete process.env.MOXXY_HOME;
  } else {
    process.env.MOXXY_HOME = previousMoxxyHome;
  }
  previousMoxxyHome = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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

  it('GET /v1/providers exposes registered providers for Virtual Office', async () => {
    const res = await fetch(`${baseUrl}/v1/providers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; display_name: string; enabled: boolean }>;
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'fake', display_name: 'fake', enabled: true }),
      ]),
    );
  });

  it('GET /v1/providers/:id/models exposes provider models for Virtual Office', async () => {
    const res = await fetch(`${baseUrl}/v1/providers/fake/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ provider_id: string; model_id: string; display_name: string }>;
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_id: 'fake',
          model_id: 'fake-model',
          display_name: 'fake-model',
        }),
      ]),
    );
  });

  it('GET /v1/agents exposes the active moxxy session as a Virtual Office agent', async () => {
    const res = await fetch(`${baseUrl}/v1/agents`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      status: string;
      provider_id: string;
      model_id: string;
      kind: string;
      origin: string;
      parent_id: string | null;
      capabilities: Record<string, boolean>;
    }>;
    expect(body).toEqual([
      expect.objectContaining({
        id: 'session',
        name: 'session',
        kind: 'session',
        origin: 'moxxy_session',
        parent_id: null,
        status: 'idle',
        provider_id: 'fake',
        model_id: 'fake-model',
        capabilities: {
          run: true,
          stop: false,
          dismiss: false,
          reset: true,
        },
      }),
    ]);
  });

  it('GET /v1/session-selection reports ready after the real bridge is booted', async () => {
    const res = await fetch(`${baseUrl}/v1/session-selection`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ready',
      sessions: [],
    });
  });

  it('POST /v1/agents creates a controllable office agent and GET /v1/agents includes it', async () => {
    const created = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        name: 'researcher',
        instructions: 'Focus on repo-level research.',
      }),
    });
    expect(created.status).toBe(200);
    const agent = (await created.json()) as {
      id: string;
      name: string;
      kind: string;
      origin: string;
      parent_id: string | null;
      capabilities: Record<string, boolean>;
    };
    expect(agent).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^office-agent-/),
        name: 'researcher',
        kind: 'office_agent',
        origin: 'virtual_office',
        parent_id: 'session',
        capabilities: {
          run: true,
          stop: true,
          dismiss: true,
          reset: true,
        },
      }),
    );

    const listed = await fetch(`${baseUrl}/v1/agents`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(listed.status).toBe(200);
    const agents = (await listed.json()) as Array<{ id: string; kind: string }>;
    expect(agents).toEqual([
      expect.objectContaining({ id: 'session', kind: 'session' }),
      expect.objectContaining({ id: agent.id, kind: 'office_agent' }),
    ]);
  });

  it('DELETE /v1/agents refuses the session but dismisses office agents', async () => {
    const sessionDelete = await fetch(`${baseUrl}/v1/agents/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(sessionDelete.status).toBe(409);

    const created = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ name: 'qa' }),
    });
    const agent = (await created.json()) as { id: string };

    const dismissed = await fetch(`${baseUrl}/v1/agents/${agent.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual({ ok: true });

    const listed = await fetch(`${baseUrl}/v1/agents`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const agents = (await listed.json()) as Array<{ id: string }>;
    expect(agents.map((entry) => entry.id)).toEqual(['session']);

    const graveyard = await fetch(`${baseUrl}/v1/graveyard`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(graveyard.status).toBe(200);
    const archived = (await graveyard.json()) as Array<{ agentId: string; outcome: string }>;
    expect(archived).toEqual([
      expect.objectContaining({ agentId: agent.id, outcome: 'stopped' }),
    ]);
  });

  it('GET /v1/commands exposes registry and Office-supported slash commands', async () => {
    const res = await fetch(`${baseUrl}/v1/commands`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      command: string;
      supported: boolean;
      reason?: string;
    }>;
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'info', command: '/info', supported: true }),
        expect.objectContaining({ name: 'new', command: '/new', supported: true }),
        expect.objectContaining({ name: 'clear', command: '/clear', supported: true }),
        expect.objectContaining({ name: 'model', command: '/model', supported: true }),
        expect.objectContaining({ name: 'loop', command: '/loop', supported: true }),
      ]),
    );
    expect(body.map((command) => command.name)).not.toEqual(
      expect.arrayContaining(['clear-queue', 'collapse', 'exit', 'expand', 'queue', 'quit', 'q', 'yolo']),
    );
  });

  it('POST /v1/commands executes parameterized Office slash commands', async () => {
    const info = await fetch(`${baseUrl}/v1/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ agent_id: 'session', command: '/info' }),
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({
      kind: 'text',
      text: 'session info from command registry',
    });

    const model = await fetch(`${baseUrl}/v1/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ agent_id: 'session', command: '/model fake::fake-model' }),
    });
    expect(model.status).toBe(200);
    expect(await model.json()).toEqual({
      kind: 'notice',
      message: 'switched to fake::fake-model',
    });

    const unsupported = await fetch(`${baseUrl}/v1/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ agent_id: 'session', command: '/exit' }),
    });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({
      error: 'unsupported',
      message: expect.stringContaining('/exit'),
    });
  });

  it('Virtual Office office-agent runs stream with the office agent id and keep separate history', async () => {
    const created = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ name: 'writer' }),
    });
    const agent = (await created.json()) as { id: string };

    const stream = await fetch(`${baseUrl}/v1/events/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const seen: Array<{ event_type: string; agent_id: string; payload: Record<string, unknown> }> = [];
    let buffer = '';
    const readUntilFinal = async (): Promise<void> => {
      while (!seen.some((event) => event.event_type === 'message.final' && event.agent_id === agent.id)) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const data = chunk
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (!data) continue;
          seen.push(JSON.parse(data));
        }
      }
    };

    const runPromise = fetch(`${baseUrl}/v1/agents/${agent.id}/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ task: 'write from the office agent' }),
    });
    await readUntilFinal();
    await reader.cancel();
    const run = await runPromise;

    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({
      agent_id: agent.id,
      task: 'write from the office agent',
      status: 'running',
    });
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'run.started',
          agent_id: agent.id,
          payload: expect.objectContaining({ task: 'write from the office agent' }),
        }),
        expect.objectContaining({
          event_type: 'message.final',
          agent_id: agent.id,
          payload: expect.objectContaining({ content: expect.stringContaining('hello') }),
        }),
      ]),
    );

    const history = await fetch(`${baseUrl}/v1/agents/${agent.id}/history`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(history.status).toBe(200);
    const body = (await history.json()) as { messages: Array<{ role: string; text: string }> };
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'write from the office agent' }),
        expect.objectContaining({ role: 'assistant', text: expect.stringContaining('hello') }),
      ]),
    );
  });

  it('Virtual Office run endpoint executes a turn and SSE maps moxxy events to gateway envelopes', async () => {
    const stream = await fetch(`${baseUrl}/v1/events/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const seen: Array<{ event_type: string; agent_id: string; payload: Record<string, unknown> }> = [];
    let buffer = '';
    const readUntilFinal = async (): Promise<void> => {
      while (!seen.some((event) => event.event_type === 'message.final')) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const data = chunk
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (!data) continue;
          seen.push(JSON.parse(data));
        }
      }
    };

    const runPromise = fetch(`${baseUrl}/v1/agents/session/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ task: 'say hi from virtual office' }),
    });
    await readUntilFinal();
    await reader.cancel();
    const run = await runPromise;

    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({
      agent_id: 'session',
      task: 'say hi from virtual office',
      status: 'running',
    });
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'run.started',
          agent_id: 'session',
          payload: expect.objectContaining({ task: 'say hi from virtual office' }),
        }),
        expect.objectContaining({
          event_type: 'message.delta',
          agent_id: 'session',
          payload: expect.objectContaining({ content: expect.stringContaining('hello') }),
        }),
        expect.objectContaining({
          event_type: 'message.final',
          agent_id: 'session',
          payload: expect.objectContaining({ content: expect.stringContaining('hello') }),
        }),
      ]),
    );

    const history = await fetch(`${baseUrl}/v1/agents/session/history`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { messages: Array<{ role: string; text: string }> };
    expect(historyBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'say hi from virtual office' }),
        expect.objectContaining({ role: 'assistant', text: expect.stringContaining('hello') }),
      ]),
    );
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
