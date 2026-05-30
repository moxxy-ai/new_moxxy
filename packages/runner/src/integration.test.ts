/**
 * End-to-end runner test: a real {@link RunnerServer} over a real unix socket,
 * driven by a {@link RemoteSession} client. Exercises the whole stack -
 * handshake + history replay, streamed turns, and the bidirectional
 * permission prompt (server->client request).
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, autoAllowResolver, silentLogger } from '@moxxy/core';
import {
  defineMode,
  definePlugin,
  defineProvider,
  defineTool,
  defineTranscriber,
  z,
} from '@moxxy/sdk';
import type {
  AssistantMessageEvent,
  CommandOutput,
  ScheduleCreateInput,
  ScheduleUpdateInput,
  SchedulerView,
} from '@moxxy/sdk';
import { FakeProvider, textReply, toolUseReply } from '@moxxy/testing';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { startRunnerServer, type RunnerServer } from './server.js';
import { connectRemoteSession, type RemoteSession } from './remote-session.js';

function buildSession(provider: FakeProvider): Session {
  const session = new Session({
    cwd: process.cwd(),
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'runner-test-shim',
      providers: [
        defineProvider({
          name: provider.name,
          models: [...provider.models],
          createClient: () => provider,
        }),
      ],
      tools: [
        defineTool({
          name: 'echo',
          description: 'echo the input text',
          inputSchema: z.object({ text: z.string() }),
          permission: { action: 'prompt' },
          handler: (input) => input.text,
        }),
      ],
    }),
  );
  session.providers.setActive(provider.name);
  session.pluginHost.registerStatic(toolUseModePlugin);
  return session;
}

function tmpSocket(): string {
  return path.join(os.tmpdir(), `moxxy-runner-${Math.random().toString(36).slice(2, 10)}.sock`);
}

/** Poll until `predicate` holds. Broadcast frames reach observers a tick after
 * the driver's own turn resolves, so observers need a moment to catch up. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const servers: RunnerServer[] = [];
const remotes: RemoteSession[] = [];

async function serve(provider: FakeProvider): Promise<{ session: Session; socketPath: string }> {
  const socketPath = tmpSocket();
  const session = buildSession(provider);
  const server = await startRunnerServer(session, { socketPath });
  servers.push(server);
  return { session, socketPath };
}

async function attach(socketPath: string, role = 'test'): Promise<RemoteSession> {
  const remote = await connectRemoteSession({ socketPath, role });
  remotes.push(remote);
  return remote;
}

afterEach(async () => {
  await Promise.all(remotes.splice(0).map((r) => r.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('runner end-to-end', () => {
  it('attach returns a snapshot that mirrors the session registries', async () => {
    const { session, socketPath } = await serve(new FakeProvider({ script: [textReply('hi')] }));
    const remote = await attach(socketPath);
    const info = remote.getInfo();
    expect(info.activeProvider).toBe('fake');
    expect(info.activeMode).toBe(session.getInfo().activeMode);
    expect(info.activeMode).toBeTruthy();
    expect(info.tools.map((t) => t.name)).toContain('echo');
    expect(info.cwd).toBe(process.cwd());
    expect(info.sessionId).toBe(session.id);
  });

  it('runTurn streams events and the assistant reply lands in the mirror', async () => {
    const { socketPath } = await serve(new FakeProvider({ script: [textReply('hi from runner')] }));
    const remote = await attach(socketPath);
    const types: string[] = [];
    for await (const event of remote.runTurn('say hi')) types.push(event.type);
    expect(types).toContain('user_prompt');
    expect(types).toContain('assistant_message');
    const msg = remote.log.ofType('assistant_message')[0] as AssistantMessageEvent | undefined;
    expect(msg?.content).toContain('hi from runner');
  });

  it('replays history to a client that attaches after a turn', async () => {
    const { socketPath } = await serve(new FakeProvider({ script: [textReply('first answer')] }));
    const a = await attach(socketPath, 'first');
    for await (const _event of a.runTurn('say hi')) void _event;

    const late = await attach(socketPath, 'late');
    expect(late.log.ofType('user_prompt').length).toBeGreaterThan(0);
    const msg = late.log.ofType('assistant_message')[0] as AssistantMessageEvent | undefined;
    expect(msg?.content).toContain('first answer');
  });

  it('replays full history even when a client attaches with sinceSeq>0', async () => {
    // Regression: the runner ignores sinceSeq and always replays from seq 0.
    // The client mirror's `ingest` only accepts contiguous seq from 0, so a
    // partial replay starting at sinceSeq>0 would drop every event and leave
    // the mirror permanently desynced. A late client must still see history and
    // stay in sync with subsequent broadcast events.
    const { socketPath } = await serve(
      new FakeProvider({ script: [textReply('first answer'), textReply('second answer')] }),
    );
    const a = await attach(socketPath, 'first');
    for await (const _event of a.runTurn('say hi')) void _event;

    // The runner now holds several events (seq 0..N). Attach asking to skip
    // ahead - the runner must ignore that and replay everything anyway.
    const skipTo = a.log.length;
    expect(skipTo).toBeGreaterThan(0);
    const late = await connectRemoteSession({ socketPath, role: 'late', sinceSeq: skipTo });
    remotes.push(late);

    // Mirror is fully populated, not empty (which is what the bug produced).
    expect(late.log.length).toBe(skipTo);
    const replayed = late.log.ofType('assistant_message')[0] as AssistantMessageEvent | undefined;
    expect(replayed?.content).toContain('first answer');

    // And it stays in sync: a turn the late client drives extends its mirror
    // contiguously rather than dropping events against a desynced index.
    for await (const _event of late.runTurn('again')) void _event;
    expect(late.log.length).toBeGreaterThan(skipTo);
    const followups = late.log.ofType('assistant_message');
    expect(followups[followups.length - 1]?.content).toContain('second answer');
  });

  it('routes a tool-call permission prompt to the turn-owning client', async () => {
    const { socketPath } = await serve(
      new FakeProvider({ script: [toolUseReply('echo', { text: 'yo' }), textReply('done')] }),
    );
    const remote = await attach(socketPath);
    const asked: string[] = [];
    remote.setPermissionResolver({
      name: 'test-resolver',
      check: async (call) => {
        asked.push(call.name);
        return { mode: 'allow' };
      },
    });

    for await (const _event of remote.runTurn('use echo')) void _event;

    expect(asked).toContain('echo');
    expect(remote.log.ofType('tool_result').length).toBeGreaterThan(0);
  });

  it('proxies registry reads + action RPCs (mode switch, command run)', async () => {
    const socketPath = tmpSocket();
    const session = buildSession(new FakeProvider({ script: [textReply('hi')] }));
    // A second mode to switch to, and a registered slash command.
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'runner-test-extras',
        modes: [
          defineMode({
            name: 'echo-mode',
             
            run: async function* () {
              return;
            },
          }),
        ],
        commands: [
          {
            name: 'ping',
            description: 'reply pong',
            handler: () => ({ kind: 'text', text: 'pong' }) as CommandOutput,
          },
        ],
      }),
    );
    const server = await startRunnerServer(session, { socketPath });
    servers.push(server);
    const remote = await attach(socketPath);

    // Reads come off the snapshot.
    expect(remote.modes.list().map((m) => m.name)).toContain('echo-mode');
    expect(remote.commands.get('ping')?.description).toBe('reply pong');

    // mode.setActive RPC flips the server's active mode; info.changed refreshes
    // the client snapshot.
    remote.modes.setActive('echo-mode');
    await waitFor(() => remote.getInfo().activeMode === 'echo-mode');
    expect(session.modes.getActive().name).toBe('echo-mode');

    // command.run RPC executes the real command on the runner.
    const result = await remote.commands.get('ping')!.handler({
      channel: 'tui',
      sessionId: remote.id,
      args: '',
      session: remote,
    });
    expect(result).toEqual({ kind: 'text', text: 'pong' });
  });

  it('proxies scheduler reads and mutations to the runner session', async () => {
    const { session, socketPath } = await serve(new FakeProvider({ script: [textReply('hi')] }));
    const schedule = {
      id: 'manual-1',
      name: 'Morning brief',
      prompt: 'Summarize the morning context.',
      enabled: true,
      source: 'manual' as const,
      skillName: null,
      workflowName: null,
      cron: '0 9 * * *',
      runAt: null,
      timeZone: 'Europe/Warsaw',
      channel: 'tui',
      model: null,
      createdAt: '2026-05-30T07:00:00.000Z',
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      nextFireAt: 1_780_000_000_000,
      nextFireIso: '2026-06-01T07:00:00.000Z',
      editable: true,
      runnable: true,
    };
    const scheduler: SchedulerView = {
      list: vi.fn(async () => [schedule]),
      create: vi.fn(async (input: ScheduleCreateInput) => ({ ...schedule, ...input, id: 'manual-created' })),
      update: vi.fn(async (_id: string, input: ScheduleUpdateInput) => ({ ...schedule, ...input })),
      setEnabled: vi.fn(async (_id: string, enabled: boolean) => ({ ...schedule, enabled })),
      delete: vi.fn(async () => ({ ok: true })),
      runNow: vi.fn(async () => ({ ok: true, text: 'queued for run', inboxPath: '/tmp/inbox.md' })),
    };
    session.scheduler = scheduler;

    const remote = await attach(socketPath);

    await expect(remote.scheduler.list({ source: 'all', includeDisabled: true })).resolves.toEqual([schedule]);
    expect(scheduler.list).toHaveBeenCalledWith({ source: 'all', includeDisabled: true });

    await expect(remote.scheduler.create({ name: 'Manual', prompt: 'Do it', cron: '0 9 * * *' })).resolves.toMatchObject({
      id: 'manual-created',
      name: 'Manual',
    });
    expect(scheduler.create).toHaveBeenCalledWith({ name: 'Manual', prompt: 'Do it', cron: '0 9 * * *' });

    await expect(remote.scheduler.setEnabled('manual-1', false)).resolves.toMatchObject({ enabled: false });
    await expect(remote.scheduler.runNow('manual-1')).resolves.toMatchObject({ ok: true, text: 'queued for run' });
  });

  it('broadcasts a turn started by one client to other attached clients', async () => {
    const { socketPath } = await serve(new FakeProvider({ script: [textReply('shared answer')] }));
    const driver = await attach(socketPath, 'driver');
    const observer = await attach(socketPath, 'observer');

    for await (const _event of driver.runTurn('say hi')) void _event;

    await waitFor(() => observer.log.ofType('assistant_message').length > 0);
    const seen = observer.log.ofType('assistant_message')[0] as AssistantMessageEvent | undefined;
    expect(seen?.content).toContain('shared answer');
  });

  it('falls back to the server resolver when the client installs none', async () => {
    // buildSession uses autoAllowResolver, which the server keeps as the
    // fall-through. A client that never calls setPermissionResolver should
    // still get its tool calls auto-allowed by that fallback.
    const { socketPath } = await serve(
      new FakeProvider({ script: [toolUseReply('echo', { text: 'hey' }), textReply('done')] }),
    );
    const remote = await attach(socketPath);
    for await (const _event of remote.runTurn('use echo')) void _event;
    expect(remote.log.ofType('tool_result').length).toBeGreaterThan(0);
  });

  it('aborts an in-flight turn when the client signals abort', async () => {
    const socketPath = tmpSocket();
    const session = buildSession(new FakeProvider({ script: [textReply('unused')] }));
    // A mode that blocks until the turn signal aborts.
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'runner-test-wait',
        modes: [
          defineMode({
            name: 'wait-mode',
             
            run: async function* (modeCtx) {
              await new Promise<void>((resolve) => {
                if (modeCtx.signal.aborted) return resolve();
                modeCtx.signal.addEventListener('abort', () => resolve(), { once: true });
              });
            },
          }),
        ],
      }),
    );
    session.modes.setActive('wait-mode');
    const server = await startRunnerServer(session, { socketPath });
    servers.push(server);
    const remote = await attach(socketPath);

    const controller = new AbortController();
    const drained = (async () => {
      for await (const _event of remote.runTurn('block', { signal: controller.signal })) {
        void _event;
      }
    })();
    // Give the turn a moment to start, then abort it.
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    // The turn must end rather than hang.
    await expect(drained).resolves.toBeUndefined();
  });

  it('routes an approval checkpoint to the turn-owning client', async () => {
    const socketPath = tmpSocket();
    const session = buildSession(new FakeProvider({ script: [textReply('unused')] }));
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'runner-test-approval',
        modes: [
          defineMode({
            name: 'approval-mode',
             
            run: async function* (modeCtx) {
              await modeCtx.approval?.confirm({
                title: 'proceed?',
                body: 'plan goes here',
                options: [{ id: 'yes', label: 'Yes' }],
                defaultOptionId: 'yes',
              });
            },
          }),
        ],
      }),
    );
    session.modes.setActive('approval-mode');
    const server = await startRunnerServer(session, { socketPath });
    servers.push(server);
    const remote = await attach(socketPath);

    const titles: string[] = [];
    remote.setApprovalResolver({
      name: 'test-approval',
      confirm: async (req) => {
        titles.push(req.title);
        return { optionId: 'yes' };
      },
    });

    for await (const _event of remote.runTurn('go')) void _event;
    expect(titles).toContain('proceed?');
  });

  it('fires onClose and flips connected when the runner stops', async () => {
    const socketPath = tmpSocket();
    const session = buildSession(new FakeProvider({ script: [textReply('hi')] }));
    const server = await startRunnerServer(session, { socketPath });
    const remote = await attach(socketPath);
    expect(remote.connected).toBe(true);

    const closed = new Promise<void>((resolve) => remote.onClose(() => resolve()));
    await server.close();
    await closed;
    expect(remote.connected).toBe(false);
  });

  it('retries the initial connect until the runner is listening', async () => {
    const socketPath = tmpSocket();
    // Begin connecting before the server exists; it should retry, not throw.
    const connecting = connectRemoteSession({ socketPath, role: 'eager' });
    await new Promise((r) => setTimeout(r, 150));
    const session = buildSession(new FakeProvider({ script: [textReply('hi')] }));
    const server = await startRunnerServer(session, { socketPath });
    servers.push(server);
    const remote = await connecting;
    remotes.push(remote);
    expect(remote.connected).toBe(true);
    expect(remote.getInfo().activeProvider).toBe('fake');
  });

  it('proxies audio transcription to the runner transcriber', async () => {
    const socketPath = tmpSocket();
    const session = buildSession(new FakeProvider({ script: [textReply('hi')] }));
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'runner-test-stt',
        transcribers: [
          defineTranscriber({
            name: 'fake-stt',
            createClient: () => ({
              name: 'fake-stt',
              transcribe: async () => ({ text: 'transcribed on the runner' }),
            }),
          }),
        ],
      }),
    );
    session.transcribers.setActive('fake-stt');
    const server = await startRunnerServer(session, { socketPath });
    servers.push(server);
    const remote = await attach(socketPath);

    expect(remote.getInfo().activeTranscriber).toBe('fake-stt');
    const transcriber = remote.transcribers.tryGetActive();
    expect(transcriber).not.toBeNull();
    const result = await transcriber!.transcribe(new Uint8Array([1, 2, 3]), {
      mimeType: 'audio/ogg',
    });
    expect(result.text).toBe('transcribed on the runner');
  });

  it('keeps routing installed when a self-hosting client sets its own resolvers', async () => {
    const socketPath = tmpSocket();
    const session = buildSession(new FakeProvider({ script: [textReply('hi')] }));
    const server = await startRunnerServer(session, { socketPath });
    servers.push(server);

    // A self-hosting TUI installs its own resolvers AFTER the runner wrapped
    // the session. These must redirect into the fallback, not replace routing -
    // otherwise an attached client's prompts would surface on the host.
    session.setApprovalResolver({ name: 'local-tui', confirm: async () => ({ optionId: 'x' }) });
    session.setPermissionResolver({ name: 'local-perm', check: async () => ({ mode: 'allow' }) });

    expect(session.approvalResolver?.name).toBe('runner-routing');
    expect(session.resolver.name).toBe('runner-routing');
  });
});
