/**
 * Channel-as-thin-client test: run the HttpChannel against a RemoteSession
 * instead of a local Session. The session (provider + loop) lives in a
 * RunnerServer; the HTTP channel is a separate "process" that attaches over a
 * unix socket and proxies turns to the runner. This is the `moxxy http
 * --attach` shape, end-to-end.
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session, autoAllowResolver, silentLogger } from '@moxxy/core';
import { defineProvider, definePlugin } from '@moxxy/sdk';
import { FakeProvider, textReply } from '@moxxy/testing';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import {
  startRunnerServer,
  connectRemoteSession,
  type RunnerServer,
  type RemoteSession,
} from '@moxxy/runner';
import { HttpChannel } from './channel.js';
import type { ChannelHandle } from '@moxxy/sdk';

function buildRunnerSession(): Session {
  const provider = new FakeProvider({ script: [textReply('hello via the runner')] });
  const session = new Session({
    cwd: process.cwd(),
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'http-attach-shim',
      providers: [
        defineProvider({
          name: provider.name,
          models: [...provider.models],
          createClient: () => provider,
        }),
      ],
    }),
  );
  session.providers.setActive(provider.name);
  session.pluginHost.registerStatic(toolUseModePlugin);
  return session;
}

function tmpSocket(): string {
  return path.join(os.tmpdir(), `moxxy-http-attach-${Math.random().toString(36).slice(2, 10)}.sock`);
}

let server: RunnerServer | null = null;
let remote: RemoteSession | null = null;
let handle: ChannelHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  await remote?.close();
  await server?.close();
  handle = null;
  remote = null;
  server = null;
});

describe('HttpChannel attached to a runner', () => {
  it('POST /v1/turn drives a turn on the remote runner session', async () => {
    const socketPath = tmpSocket();
    server = await startRunnerServer(buildRunnerSession(), { socketPath });
    remote = await connectRemoteSession({ socketPath, role: 'http' });

    const port = 50000 + Math.floor(Math.random() * 10000);
    const channel = new HttpChannel({ port, host: '127.0.0.1', allowedTools: [] });
    handle = await channel.start({ session: remote });

    const res = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'say hi' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }>; assistant: string };
    expect(body.assistant).toContain('hello via the runner');
    expect(body.events.some((e) => e.type === 'user_prompt')).toBe(true);
    expect(body.events.some((e) => e.type === 'assistant_message')).toBe(true);
  });
});
