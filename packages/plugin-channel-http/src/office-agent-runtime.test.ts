import { describe, expect, it } from 'vitest';
import { EventLog, Session, autoAllowResolver, silentLogger } from '@moxxy/core';
import { defineProvider, definePlugin, defineTool } from '@moxxy/sdk';
import { z } from 'zod';
import { FakeProvider, textReply, toolUseReply } from '@moxxy/testing';
import { toolUseModePlugin } from '@moxxy/mode-tool-use';
import { builtinToolsPlugin } from '@moxxy/tools-builtin';
import { OfficeAgentRuntime } from './office-agent-runtime.js';
import { HttpPermissionBroker } from './permission-broker.js';

function buildSession(log?: EventLog): Session {
  const provider = new FakeProvider({
    script: [textReply('office agent completed the task')],
  });
  const session = new Session({
    cwd: process.cwd(),
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
    ...(log ? { log } : {}),
  });
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'office-agent-runtime-test-provider',
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
  session.pluginHost.registerStatic(builtinToolsPlugin);
  session.pluginHost.registerStatic(toolUseModePlugin);
  return session;
}

async function waitForLog(
  session: Session,
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for office log');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('OfficeAgentRuntime persistence', () => {
  it('persists office agent lifecycle and run history as session plugin events', async () => {
    const session = buildSession();
    const runtime = new OfficeAgentRuntime(session, silentLogger);

    const agent = await runtime.create({ name: 'researcher' });
    runtime.startRun(agent.id, 'research the repo');

    await waitForLog(session, () =>
      session.log.ofType('plugin_event').some((event) => event.subtype === 'office_agent.message_final'),
    );

    const subtypes = session.log.ofType('plugin_event').map((event) => event.subtype);
    expect(subtypes).toEqual(
      expect.arrayContaining([
        'office_agent.created',
        'office_agent.run_started',
        'office_agent.message_final',
        'office_agent.run_completed',
      ]),
    );
  });

  it('archives dismissed office agents with chat and log history', async () => {
    const session = buildSession();
    const runtime = new OfficeAgentRuntime(session, silentLogger);

    const agent = await runtime.create({ name: 'qa' });
    runtime.startRun(agent.id, 'check the release');
    await waitForLog(session, () =>
      session.log.ofType('plugin_event').some((event) => event.subtype === 'office_agent.message_final'),
    );

    await runtime.dismiss(agent.id);

    const graveyard = runtime.graveyard();
    expect(graveyard).toHaveLength(1);
    expect(graveyard[0]).toMatchObject({
      agentId: agent.id,
      agentName: 'qa',
      outcome: 'stopped',
      isSubagent: false,
      task: 'check the release',
      lastMessage: expect.stringContaining('office agent completed'),
    });
    expect(graveyard[0].chatHistory.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(graveyard[0].logHistory.map((item) => item.eventType)).toEqual(
      expect.arrayContaining(['run.started', 'message.final', 'run.completed']),
    );
  });

  it('projects unarchived office agents from a restored session log into graveyard, not live agents', async () => {
    const session = buildSession();
    const runtime = new OfficeAgentRuntime(session, silentLogger);

    const agent = await runtime.create({ name: 'analyst' });
    runtime.startRun(agent.id, 'summarise context');
    await waitForLog(session, () =>
      session.log.ofType('plugin_event').some((event) => event.subtype === 'office_agent.message_final'),
    );

    const restoredSession = buildSession(new EventLog(session.log.toJSON()));
    const restoredRuntime = new OfficeAgentRuntime(restoredSession, silentLogger);

    expect(restoredRuntime.list().map((entry) => entry.id)).toEqual(['session']);
    expect(restoredRuntime.graveyard()).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        agentName: 'analyst',
        outcome: 'stopped',
        task: 'summarise context',
      }),
    ]);
  });

  it('routes office-agent tool permissions through the HTTP permission broker', async () => {
    const provider = new FakeProvider({
      script: [toolUseReply('web_fetch', { url: 'https://example.com' }, 'call-1'), textReply('done')],
    });
    const session = new Session({
      cwd: process.cwd(),
      logger: silentLogger,
      permissionResolver: autoAllowResolver,
    });
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'office-agent-permission-test-provider',
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
    session.tools.register(
      defineTool({
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        handler: () => 'fetched',
      }),
    );

    const broker = new HttpPermissionBroker();
    broker.attachSession(session);
    session.setPermissionResolver(broker);
    const runtime = new OfficeAgentRuntime(session, silentLogger, broker);

    const agent = await runtime.create({ name: 'researcher' });
    runtime.startRun(agent.id, 'search the web');

    await waitForLog(session, () =>
      session.log.ofType('plugin_event').some((event) => event.subtype === 'permission.requested'),
    );

    const request = session.log
      .ofType('plugin_event')
      .find((event) => event.subtype === 'permission.requested');
    expect(request?.payload).toMatchObject({
      agent_id: agent.id,
      tool_name: 'web_fetch',
    });
    const requestId = (request?.payload as { request_id?: string } | undefined)?.request_id;
    expect(requestId).toBeTruthy();

    expect(await broker.decide(requestId!, { mode: 'allow_session', reason: 'test allow' })).toBe(true);

    await waitForLog(session, () =>
      session.log.ofType('plugin_event').some((event) => event.subtype === 'office_agent.message_final'),
    );
    expect(
      session.log.ofType('plugin_event').some((event) => event.subtype === 'permission.resolved'),
    ).toBe(true);
  });
});
