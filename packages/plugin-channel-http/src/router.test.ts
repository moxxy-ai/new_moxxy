import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Session, silentLogger } from '@moxxy/core';
import { defineCommand, defineMode, definePlugin, defineProvider, defineTool, defineTranscriber, z, type ModeContext } from '@moxxy/sdk';
import {
  routeRequest,
  handleHealth,
  handleAgentRun,
  handleCommands,
  handleDeskGet,
  handleDeskPut,
  handleInputCapabilities,
  handleMediaPreview,
  handleRunCommand,
  handleTranscription,
  handleTurnAudio,
  workspaceDeskId,
  turnRequestSchema,
} from './router.js';
import { OfficeAgentRuntime } from './office-agent-runtime.js';

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
  _rawBody: Buffer;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string | number | string[]>,
    _body: '',
    _rawBody: Buffer.alloc(0),
    headersSent: false,
    writeHead(status: number, headers: Record<string, string | number | string[]>) {
      this._status = status;
      this._headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body?: string | Buffer | Uint8Array) {
      if (body !== undefined) {
        const chunk = Buffer.isBuffer(body) ? body : Buffer.from(body);
        this._rawBody = Buffer.concat([this._rawBody, chunk]);
        this._body += chunk.toString('utf8');
      }
      return this;
    },
    write(chunk: string | Buffer | Uint8Array) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this._rawBody = Buffer.concat([this._rawBody, buffer]);
      this._body += buffer.toString('utf8');
      return true;
    },
  } as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string | number | string[]>;
    _body: string;
    _rawBody: Buffer;
  };
  return res;
}

async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Parameters<NonNullable<ReturnType<typeof routeRequest>>>[2],
): Promise<void> {
  const handler = routeRequest(req);
  expect(handler).not.toBeNull();
  await handler!(req, res, ctx);
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

  it('matches Virtual Office input capability and transcription endpoints', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/v1/input-capabilities' }))).toBe(
      handleInputCapabilities,
    );
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/transcriptions' }))).toBe(
      handleTranscription,
    );
  });

  it('matches Virtual Office media preview endpoint', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/v1/media/preview' }))).toBe(
      handleMediaPreview,
    );
  });

  it('matches Virtual Office vault management endpoints', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/v1/vault/secrets' }))).not.toBeNull();
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/vault/secrets' }))).not.toBeNull();
    expect(routeRequest(makeIncoming({ method: 'DELETE', url: '/v1/vault/secrets/OPENAI_API_KEY' }))).not.toBeNull();
  });

  it('matches Virtual Office MCP management endpoints', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/v1/agents/session/mcp' }))).not.toBeNull();
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/agents/session/mcp' }))).not.toBeNull();
    expect(routeRequest(makeIncoming({ method: 'DELETE', url: '/v1/agents/session/mcp/filesystem' }))).not.toBeNull();
    expect(routeRequest(makeIncoming({ method: 'POST', url: '/v1/agents/session/mcp/filesystem/test' }))).not.toBeNull();
  });

  it('matches Virtual Office workflow builder endpoints', () => {
    const cases = [
      ['GET', '/v1/workflows'],
      ['GET', '/v1/workflows/capabilities'],
      ['POST', '/v1/desk/0/workflows/office-flow/run'],
      ['POST', '/v1/workflows/draft'],
      ['POST', '/v1/workflows/validate'],
      ['POST', '/v1/workflows'],
      ['GET', '/v1/workflows/daily-digest'],
      ['PUT', '/v1/workflows/daily-digest'],
      ['DELETE', '/v1/workflows/daily-digest'],
      ['POST', '/v1/workflows/daily-digest/enabled'],
      ['POST', '/v1/workflows/daily-digest/run'],
    ] as const;
    for (const [method, url] of cases) {
      expect(routeRequest(makeIncoming({ method, url }))).not.toBeNull();
    }
  });

  it('matches Virtual Office scheduler endpoints', () => {
    const cases = [
      ['GET', '/v1/schedules'],
      ['GET', '/v1/schedules?source=workflow&includeDisabled=true'],
      ['POST', '/v1/schedules'],
      ['PUT', '/v1/schedules/morning-brief'],
      ['POST', '/v1/schedules/morning-brief/enabled'],
      ['DELETE', '/v1/schedules/morning-brief'],
      ['POST', '/v1/schedules/morning-brief/run'],
    ] as const;
    for (const [method, url] of cases) {
      expect(routeRequest(makeIncoming({ method, url }))).not.toBeNull();
    }
  });

  it('matches Virtual Office desk persistence endpoints', () => {
    expect(routeRequest(makeIncoming({ method: 'GET', url: '/v1/desk/4' }))).toBe(handleDeskGet);
    expect(routeRequest(makeIncoming({ method: 'PUT', url: '/v1/desk/4' }))).toBe(handleDeskPut);
  });
});

describe('Virtual Office desk persistence endpoints', () => {
  const previousHome = process.env.MOXXY_HOME;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.MOXXY_HOME;
    else process.env.MOXXY_HOME = previousHome;
  });

  it('seeds, stores atomically and isolates desk state per workspace and computer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moxxy-desk-'));
    const cwd = join(home, 'workspace');
    process.env.MOXXY_HOME = home;

    try {
      const ctx = {
        session: { id: 'session-1', cwd },
        authToken: 'x',
        logger: silentLogger,
      } as never;

      const seedRes = makeResponse();
      await dispatchRoute(
        makeIncoming({
          method: 'GET',
          url: '/v1/desk/4',
          headers: { authorization: 'Bearer x' },
        }),
        seedRes,
        ctx,
      );

      expect(seedRes._status).toBe(200);
      expect(JSON.parse(seedRes._body)).toEqual({ version: 1 });

      const deskFour = {
        version: 1,
        fileSystem: { rootId: 'root-a', nodes: {} },
        workflows: {
          selected: { workflow: { name: 'draft-a' } },
        },
      };
      const putRes = makeResponse();
      await dispatchRoute(
        makeIncoming({
          method: 'PUT',
          url: '/v1/desk/4',
          headers: { authorization: 'Bearer x' },
          body: JSON.stringify(deskFour),
        }),
        putRes,
        ctx,
      );

      expect(putRes._status).toBe(200);
      expect(JSON.parse(putRes._body)).toEqual(deskFour);

      const deskFive = {
        version: 1,
        fileSystem: { rootId: 'root-b', nodes: {} },
      };
      const putOtherDeskRes = makeResponse();
      await dispatchRoute(
        makeIncoming({
          method: 'PUT',
          url: '/v1/desk/5',
          headers: { authorization: 'Bearer x' },
          body: JSON.stringify(deskFive),
        }),
        putOtherDeskRes,
        ctx,
      );

      const reloadRes = makeResponse();
      await dispatchRoute(
        makeIncoming({
          method: 'GET',
          url: '/v1/desk/4',
          headers: { authorization: 'Bearer x' },
        }),
        reloadRes,
        ctx,
      );

      expect(JSON.parse(reloadRes._body)).toEqual(deskFour);

      const file = join(home, 'desk', workspaceDeskId(cwd), 'desk-4.json');
      await expect(stat(file)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(readFile(file, 'utf8')).resolves.toContain('draft-a');

      const otherWorkspaceRes = makeResponse();
      await dispatchRoute(
        makeIncoming({
          method: 'GET',
          url: '/v1/desk/4',
          headers: { authorization: 'Bearer x' },
        }),
        otherWorkspaceRes,
        { session: { id: 'session-2', cwd: join(home, 'other-workspace') }, authToken: 'x', logger: silentLogger } as never,
      );

      expect(JSON.parse(otherWorkspaceRes._body)).toEqual({ version: 1 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('Virtual Office workflow endpoints', () => {
  const sampleWorkflow = {
    name: 'daily-digest',
    description: 'Daily digest.',
    version: 1,
    enabled: true,
    inputs: {},
    concurrency: 1,
    steps: [
      {
        id: 'summarize',
        prompt: 'Summarize today',
        needs: [],
        onError: 'fail',
        retries: 0,
      },
    ],
    ui: { layout: { nodes: { summarize: { x: 120, y: 80 } } } },
  };

  function workflowCtx(overrides: Record<string, unknown> = {}) {
    const workflows = {
      list: vi.fn(async () => [{ name: 'daily-digest', description: 'Daily digest.', enabled: true, scope: 'user', steps: 1, triggers: 'on-demand' }]),
      capabilities: vi.fn(async () => ({
        skills: [{ name: 'gmail', description: 'Send mail' }],
        tools: [{ name: 'web_fetch', description: 'Fetch URL' }],
        mcp: [{ name: 'mcp__exa__search', description: 'Exa search' }],
        workflows: [{ name: 'daily-digest', description: 'Daily digest.' }],
      })),
      draft: vi.fn(async () => ({ workflow: sampleWorkflow, raw: 'name: daily-digest', errors: [] })),
      validate: vi.fn(async () => ({ ok: true, errors: [] })),
      create: vi.fn(async () => ({ workflow: sampleWorkflow, scope: 'user' })),
      get: vi.fn(async () => ({ workflow: sampleWorkflow, scope: 'user', yaml: 'name: daily-digest' })),
      update: vi.fn(async (_name: string, workflow: unknown) => ({ workflow, scope: 'user' })),
      delete: vi.fn(async () => ({ ok: true })),
      setEnabled: vi.fn(async () => {}),
      run: vi.fn(async () => ({ ok: true, output: 'done', steps: [{ id: 'summarize', status: 'completed' }] })),
      ...overrides,
    };
    return {
      workflows,
      ctx: { session: { workflows }, authToken: 'x', logger: silentLogger } as never,
    };
  }

  it('returns 404 when workflow support is unavailable', async () => {
    const res = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'GET',
        url: '/v1/workflows',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      { session: {}, authToken: 'x', logger: silentLogger } as never,
    );

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ error: 'not_found' });
  });

  it('maps workflow GUI calls to the session workflows view', async () => {
    const { workflows, ctx } = workflowCtx();

    const listRes = makeResponse();
    await dispatchRoute(makeIncoming({ method: 'GET', url: '/v1/workflows', headers: { authorization: 'Bearer x' } }), listRes, ctx);
    expect(listRes._status).toBe(200);
    expect(JSON.parse(listRes._body)[0]).toMatchObject({ name: 'daily-digest' });

    const capsRes = makeResponse();
    await dispatchRoute(makeIncoming({ method: 'GET', url: '/v1/workflows/capabilities', headers: { authorization: 'Bearer x' } }), capsRes, ctx);
    expect(capsRes._status).toBe(200);
    expect(JSON.parse(capsRes._body).tools[0]).toMatchObject({ name: 'web_fetch' });

    const draftRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/workflows/draft',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ intent: 'send a digest every morning' }),
      }),
      draftRes,
      ctx,
    );
    expect(draftRes._status).toBe(200);
    expect(workflows.draft).toHaveBeenCalledWith('send a digest every morning');

    const validateRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/workflows/validate',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ workflow: sampleWorkflow }),
      }),
      validateRes,
      ctx,
    );
    expect(validateRes._status).toBe(200);
    expect(workflows.validate).toHaveBeenCalledWith(sampleWorkflow);

    const createRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/workflows',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ workflow: sampleWorkflow, scope: 'user' }),
      }),
      createRes,
      ctx,
    );
    expect(createRes._status).toBe(200);
    expect(workflows.create).toHaveBeenCalledWith(sampleWorkflow, 'user');

    const getRes = makeResponse();
    await dispatchRoute(makeIncoming({ method: 'GET', url: '/v1/workflows/daily-digest', headers: { authorization: 'Bearer x' } }), getRes, ctx);
    expect(getRes._status).toBe(200);
    expect(workflows.get).toHaveBeenCalledWith('daily-digest');

    const updateRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'PUT',
        url: '/v1/workflows/daily-digest',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ workflow: { ...sampleWorkflow, description: 'Updated' } }),
      }),
      updateRes,
      ctx,
    );
    expect(updateRes._status).toBe(200);
    expect(workflows.update).toHaveBeenCalledWith('daily-digest', { ...sampleWorkflow, description: 'Updated' });

    const enableRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/workflows/daily-digest/enabled',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ enabled: false }),
      }),
      enableRes,
      ctx,
    );
    expect(enableRes._status).toBe(200);
    expect(workflows.setEnabled).toHaveBeenCalledWith('daily-digest', false);

    const runRes = makeResponse();
    await dispatchRoute(makeIncoming({
      method: 'POST',
      url: '/v1/workflows/daily-digest/run',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: { region: 'EU' } }),
    }), runRes, ctx);
    expect(runRes._status).toBe(200);
    expect(JSON.parse(runRes._body)).toMatchObject({ ok: true, output: 'done' });
    expect(workflows.run).toHaveBeenCalledWith('daily-digest', { region: 'EU' });

    const deleteRes = makeResponse();
    await dispatchRoute(makeIncoming({ method: 'DELETE', url: '/v1/workflows/daily-digest', headers: { authorization: 'Bearer x' } }), deleteRes, ctx);
    expect(deleteRes._status).toBe(200);
    expect(workflows.delete).toHaveBeenCalledWith('daily-digest');
  });
});

describe('Virtual Office scheduler endpoints', () => {
  const manualSchedule = {
    id: 'manual-1',
    name: 'Morning brief',
    prompt: 'Summarize the morning context.',
    enabled: true,
    source: 'manual',
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

  const workflowSchedule = {
    ...manualSchedule,
    id: 'workflow-1',
    name: 'daily-research',
    prompt: 'Run workflow daily-research.',
    source: 'workflow',
    workflowName: 'daily-research',
    editable: false,
  };

  const skillSchedule = {
    ...manualSchedule,
    id: 'skill-1',
    name: 'sync-skill',
    prompt: 'Run sync skill.',
    source: 'skill',
    skillName: 'sync-skill',
    editable: false,
  };

  function schedulerCtx(overrides: Record<string, unknown> = {}) {
    const scheduler = {
      list: vi.fn(async () => [manualSchedule, workflowSchedule, skillSchedule]),
      create: vi.fn(async (input: unknown) => ({ ...manualSchedule, ...input, id: 'manual-created' })),
      update: vi.fn(async (_id: string, input: unknown) => ({ ...manualSchedule, ...input })),
      setEnabled: vi.fn(async (_id: string, enabled: boolean) => ({ ...manualSchedule, enabled })),
      delete: vi.fn(async () => ({ ok: true })),
      runNow: vi.fn(async () => ({ ok: true, text: 'queued for run', inboxPath: '/tmp/inbox.md' })),
      ...overrides,
    };
    return {
      scheduler,
      ctx: { session: { scheduler }, authToken: 'x', logger: silentLogger } as never,
    };
  }

  it('returns 404 when scheduler support is unavailable', async () => {
    const res = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'GET',
        url: '/v1/schedules',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      { session: {}, authToken: 'x', logger: silentLogger } as never,
    );

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ error: 'not_found' });
  });

  it('lists schedules through the session scheduler view with source filters', async () => {
    const { scheduler, ctx } = schedulerCtx();

    const res = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'GET',
        url: '/v1/schedules?source=workflow&includeDisabled=true',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      ctx,
    );

    expect(res._status).toBe(200);
    expect(scheduler.list).toHaveBeenCalledWith({ source: 'workflow', includeDisabled: true });
    expect(JSON.parse(res._body)).toEqual([manualSchedule, workflowSchedule, skillSchedule]);
  });

  it('creates manual schedules and refreshable schedule entries', async () => {
    const { scheduler, ctx } = schedulerCtx();

    const res = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/schedules',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          name: 'Manual from UI',
          prompt: 'Check invoices.',
          cron: '30 8 * * 1-5',
          timeZone: 'Europe/Warsaw',
          enabled: true,
        }),
      }),
      res,
      ctx,
    );

    expect(res._status).toBe(200);
    expect(scheduler.create).toHaveBeenCalledWith({
      name: 'Manual from UI',
      prompt: 'Check invoices.',
      cron: '30 8 * * 1-5',
      timeZone: 'Europe/Warsaw',
      enabled: true,
    });
    expect(JSON.parse(res._body)).toMatchObject({ id: 'manual-created', source: 'manual' });
  });

  it('updates, enables and deletes manual schedules only', async () => {
    const { scheduler, ctx } = schedulerCtx();

    const updateRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'PUT',
        url: '/v1/schedules/manual-1',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ name: 'Morning brief updated', enabled: false }),
      }),
      updateRes,
      ctx,
    );
    expect(updateRes._status).toBe(200);
    expect(scheduler.update).toHaveBeenCalledWith('manual-1', { name: 'Morning brief updated', enabled: false });

    const enabledRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/schedules/manual-1/enabled',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ enabled: false }),
      }),
      enabledRes,
      ctx,
    );
    expect(enabledRes._status).toBe(200);
    expect(scheduler.setEnabled).toHaveBeenCalledWith('manual-1', false);

    const deleteRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'DELETE',
        url: '/v1/schedules/manual-1',
        headers: { authorization: 'Bearer x' },
      }),
      deleteRes,
      ctx,
    );
    expect(deleteRes._status).toBe(200);
    expect(scheduler.delete).toHaveBeenCalledWith('manual-1');
  });

  it('rejects write operations for workflow and skill managed schedules', async () => {
    const { scheduler, ctx } = schedulerCtx();

    const updateRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'PUT',
        url: '/v1/schedules/workflow-1',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({ name: 'Changed elsewhere' }),
      }),
      updateRes,
      ctx,
    );
    expect(updateRes._status).toBe(409);
    expect(JSON.parse(updateRes._body)).toMatchObject({ error: 'read_only_schedule' });
    expect(scheduler.update).not.toHaveBeenCalled();

    const deleteRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'DELETE',
        url: '/v1/schedules/skill-1',
        headers: { authorization: 'Bearer x' },
      }),
      deleteRes,
      ctx,
    );
    expect(deleteRes._status).toBe(409);
    expect(JSON.parse(deleteRes._body)).toMatchObject({ error: 'read_only_schedule' });
    expect(scheduler.delete).not.toHaveBeenCalled();
  });

  it('runs any existing schedule on demand', async () => {
    const { scheduler, ctx } = schedulerCtx();

    const res = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/schedules/workflow-1/run',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      ctx,
    );

    expect(res._status).toBe(200);
    expect(scheduler.runNow).toHaveBeenCalledWith('workflow-1');
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, text: 'queued for run' });
  });
});

describe('Virtual Office admin action endpoints', () => {
  const ctx = (session: Session) => ({ session, authToken: 'x', logger: silentLogger });

  function sessionWithAdminTools() {
    const session = new Session({ cwd: '/tmp', silent: true });
    const captures: Record<string, unknown> = {};
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'router-office-admin-tools',
        tools: [
          defineTool({
            name: 'vault_list',
            description: 'list vault entries',
            inputSchema: z.object({}),
            handler: () => [
              {
                name: 'OPENAI_API_KEY',
                createdAt: '2026-01-01T00:00:00.000Z',
                tags: ['default'],
              },
            ],
          }),
          defineTool({
            name: 'vault_set',
            description: 'store vault entry',
            inputSchema: z.object({
              name: z.string(),
              value: z.string(),
              tags: z.array(z.string()).optional(),
            }),
            handler: (input) => {
              captures.vaultSet = input;
              return 'stored';
            },
          }),
          defineTool({
            name: 'vault_delete',
            description: 'delete vault entry',
            inputSchema: z.object({ name: z.string() }),
            handler: (input) => {
              captures.vaultDelete = input;
              return 'deleted';
            },
          }),
          defineTool({
            name: 'mcp_list_servers',
            description: 'list MCP servers',
            inputSchema: z.object({}),
            handler: () => [
              {
                name: 'filesystem',
                kind: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem'],
                env: { NODE_ENV: 'test' },
              },
              {
                name: 'remote-docs',
                kind: 'http',
                url: 'https://mcp.example.test/mcp',
                headers: { Authorization: 'Bearer token' },
                disabled: true,
              },
            ],
          }),
          defineTool({
            name: 'mcp_add_server',
            description: 'add MCP server',
            inputSchema: z.object({
              name: z.string(),
              kind: z.enum(['stdio', 'http', 'sse']),
              command: z.string().optional(),
              args: z.array(z.string()).optional(),
              env: z.record(z.string()).optional(),
              url: z.string().optional(),
              headers: z.record(z.string()).optional(),
              autoSkill: z.boolean().default(true),
            }),
            handler: (input) => {
              captures.mcpAdd = input;
              return {
                ok: true,
                name: input.name,
                tools: ['mcp__docs__search'],
              };
            },
          }),
          defineTool({
            name: 'mcp_remove_server',
            description: 'remove MCP server',
            inputSchema: z.object({ name: z.string() }),
            handler: (input) => {
              captures.mcpRemove = input;
              return { ok: true };
            },
          }),
          defineTool({
            name: 'mcp_test_server',
            description: 'test MCP server',
            inputSchema: z.object({
              name: z.string(),
              kind: z.enum(['stdio', 'http', 'sse']),
              command: z.string().optional(),
              args: z.array(z.string()).optional(),
              env: z.record(z.string()).optional(),
              url: z.string().optional(),
              headers: z.record(z.string()).optional(),
              autoSkill: z.boolean().default(false),
            }),
            handler: (input) => {
              captures.mcpTest = input;
              return {
                ok: true,
                name: input.name,
                tools: [{ name: 'mcp__filesystem__read_file' }],
              };
            },
          }),
        ],
      }),
    );
    return { session, captures };
  }

  it('maps Vault list/create/delete GUI calls to the registered vault tools', async () => {
    const { session, captures } = sessionWithAdminTools();

    const listRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'GET',
        url: '/v1/vault/secrets',
        headers: { authorization: 'Bearer x' },
      }),
      listRes,
      ctx(session),
    );

    expect(listRes._status).toBe(200);
    expect(JSON.parse(listRes._body)).toEqual([
      {
        id: 'OPENAI_API_KEY',
        key_name: 'OPENAI_API_KEY',
        backend_key: 'OPENAI_API_KEY',
        policy_label: 'default',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const createRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/vault/secrets',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          key_name: 'ANTHROPIC_API_KEY',
          backend_key: 'ANTHROPIC_API_KEY',
          value: 'sk-ant',
          policy_label: 'provider',
        }),
      }),
      createRes,
      ctx(session),
    );

    expect(createRes._status).toBe(200);
    expect(captures.vaultSet).toEqual({
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-ant',
      tags: ['provider'],
    });
    expect(JSON.parse(createRes._body)).toMatchObject({
      id: 'ANTHROPIC_API_KEY',
      key_name: 'ANTHROPIC_API_KEY',
      backend_key: 'ANTHROPIC_API_KEY',
      policy_label: 'provider',
    });

    const deleteRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'DELETE',
        url: '/v1/vault/secrets/ANTHROPIC_API_KEY',
        headers: { authorization: 'Bearer x' },
      }),
      deleteRes,
      ctx(session),
    );

    expect(deleteRes._status).toBe(200);
    expect(captures.vaultDelete).toEqual({ name: 'ANTHROPIC_API_KEY' });
    expect(JSON.parse(deleteRes._body)).toEqual({ ok: true });
  });

  it('maps MCP list/add/remove/test GUI calls to the registered MCP admin tools', async () => {
    const { session, captures } = sessionWithAdminTools();

    const listRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'GET',
        url: '/v1/agents/session/mcp',
        headers: { authorization: 'Bearer x' },
      }),
      listRes,
      ctx(session),
    );

    expect(listRes._status).toBe(200);
    expect(JSON.parse(listRes._body)).toEqual({
      servers: [
        {
          id: 'filesystem',
          transport: 'stdio',
          enabled: true,
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { NODE_ENV: 'test' },
        },
        {
          id: 'remote-docs',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      ],
    });

    const addRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/agents/session/mcp',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify({
          id: 'docs',
          transport: 'streamable_http',
          url: 'https://mcp.docs.example/mcp',
          headers: { Authorization: 'Bearer docs' },
        }),
      }),
      addRes,
      ctx(session),
    );

    expect(addRes._status).toBe(200);
    expect(captures.mcpAdd).toEqual({
      name: 'docs',
      kind: 'http',
      url: 'https://mcp.docs.example/mcp',
      headers: { Authorization: 'Bearer docs' },
      autoSkill: true,
    });
    expect(JSON.parse(addRes._body)).toMatchObject({
      id: 'docs',
      transport: 'streamable_http',
      enabled: true,
      url: 'https://mcp.docs.example/mcp',
    });

    const removeRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'DELETE',
        url: '/v1/agents/session/mcp/filesystem',
        headers: { authorization: 'Bearer x' },
      }),
      removeRes,
      ctx(session),
    );

    expect(removeRes._status).toBe(200);
    expect(captures.mcpRemove).toEqual({ name: 'filesystem' });

    const testRes = makeResponse();
    await dispatchRoute(
      makeIncoming({
        method: 'POST',
        url: '/v1/agents/session/mcp/filesystem/test',
        headers: { authorization: 'Bearer x' },
      }),
      testRes,
      ctx(session),
    );

    expect(testRes._status).toBe(200);
    expect(captures.mcpTest).toEqual({
      name: 'filesystem',
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { NODE_ENV: 'test' },
      autoSkill: false,
    });
    expect(JSON.parse(testRes._body)).toEqual({
      status: 'ok',
      server_id: 'filesystem',
      tools: ['mcp__filesystem__read_file'],
    });
  });

  it('hides terminal-only and unsupported commands from the Office action catalog', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'router-office-command-catalog',
        commands: [
          defineCommand({
            name: 'exit',
            description: 'Quit terminal',
            handler: () => ({ kind: 'session-action', action: 'exit' }),
          }),
          defineCommand({
            name: 'compact',
            description: 'Compact conversation',
            handler: () => ({ kind: 'text', text: 'ok' }),
          }),
        ],
      }),
    );

    const res = makeResponse();
    await handleCommands(
      makeIncoming({
        method: 'GET',
        url: '/v1/commands',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(200);
    const names = JSON.parse(res._body).map((command: { name: string }) => command.name);
    expect(names).toContain('compact');
    expect(names).toContain('tools');
    expect(names).not.toEqual(expect.arrayContaining([
      'clear-queue',
      'collapse',
      'exit',
      'expand',
      'q',
      'queue',
      'quit',
      'yolo',
    ]));
  });
});

describe('Virtual Office input endpoints', () => {
  const ctx = (session: Session) => ({ session, authToken: 'x', logger: silentLogger });

  function makeCodexSession(opts: { oauthReady?: boolean; supportsImages?: boolean; transcript?: string } = {}): Session {
    const session = new Session({ cwd: '/tmp', silent: true });
    const models = [
      {
        id: 'gpt-5.5',
        contextWindow: 300_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsImages: opts.supportsImages ?? true,
      },
    ];
    session.pluginHost.registerStatic(
      definePlugin({
        name: 'router-codex-input-test',
        providers: [
          defineProvider({
            name: 'openai-codex',
            models,
            createClient: () => ({
              name: 'openai-codex',
              models,
              stream: async function* () {},
              countTokens: async () => 0,
            }),
          }),
        ],
        transcribers: [
          defineTranscriber({
            name: 'openai-codex-transcribe',
            createClient: () => ({
              name: 'openai-codex-transcribe',
              transcribe: async () => ({ text: opts.transcript ?? 'transcribed text' }),
            }),
          }),
        ],
      }),
    );
    session.providers.setActive('openai-codex');
    if (opts.oauthReady ?? true) session.requirements.setRuntime('auth:provider:openai-codex', 'ready');
    return session;
  }

  function captureMode(session: Session): { getSystemPrompt: () => string | undefined } {
    let systemPrompt: string | undefined;
    session.pluginHost.registerStatic(
      definePlugin({
        name: `router-capture-mode-${Math.random().toString(16).slice(2)}`,
        modes: [
          defineMode({
            name: 'capture-office-run',
            run: async function* (ctx: ModeContext) {
              systemPrompt = ctx.systemPrompt;
            },
          }),
        ],
      }),
    );
    session.modes.setActive('capture-office-run');
    return { getSystemPrompt: () => systemPrompt };
  }

  function materializedPathFromPrompt(prompt: string | undefined): string {
    expect(prompt).toContain('Virtual Office uploaded image attachments');
    const match = prompt?.match(/\/[^\n]+?\.png/);
    expect(match?.[0]).toBeTruthy();
    return match![0];
  }

  it('reports voice and image readiness without leaking auth data', async () => {
    const session = makeCodexSession({ supportsImages: true });
    const res = makeResponse();

    await handleInputCapabilities(
      makeIncoming({
        method: 'GET',
        url: '/v1/input-capabilities',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      voice: {
        ready: true,
        reason: null,
        transcriber: 'openai-codex-transcribe',
      },
      active_model: {
        provider_id: 'openai-codex',
        model_id: 'gpt-5.5',
        supports_images: true,
        supports_audio: false,
      },
    });
    expect(res._body).not.toContain('Bearer');
    expect(res._body).not.toContain('token');
  });

  it('returns voice unavailable when Codex OAuth is not ready', async () => {
    const session = makeCodexSession({ oauthReady: false });
    const res = makeResponse();

    await handleInputCapabilities(
      makeIncoming({
        method: 'GET',
        url: '/v1/input-capabilities',
        headers: { authorization: 'Bearer x' },
      }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({
      voice: {
        ready: false,
        transcriber: 'openai-codex-transcribe',
      },
    });
    expect(JSON.parse(res._body).voice.reason).toContain('openai-codex');
  });

  it('transcribes raw browser audio without starting a run', async () => {
    const session = makeCodexSession({ transcript: 'voice prompt' });
    const res = makeResponse();

    await handleTranscription(
      makeIncoming({
        method: 'POST',
        url: '/v1/transcriptions',
        headers: { 'content-type': 'audio/webm', authorization: 'Bearer x' },
        body: 'webmbytes',
      }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ transcript: 'voice prompt' });
    expect(session.log.ofType('user_prompt')).toHaveLength(0);
  });

  it('rejects non-audio transcription uploads', async () => {
    const session = makeCodexSession();
    const res = makeResponse();

    await handleTranscription(
      makeIncoming({
        method: 'POST',
        url: '/v1/transcriptions',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: '{}',
      }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(415);
  });

  it('accepts image attachment payloads larger than the default JSON body limit', async () => {
    const session = makeCodexSession({ supportsImages: true });
    const res = makeResponse();
    const imageContent = Buffer.alloc(70 * 1024, 1).toString('base64');

    await handleAgentRun(
      makeIncoming({
        method: 'POST',
        url: '/v1/agents/session/runs',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify({
          task: 'Describe this image',
          attachments: [
            {
              kind: 'image',
              content: imageContent,
              mediaType: 'image/png',
              name: 'large-enough.png',
            },
          ],
        }),
      }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({
      agent_id: 'session',
      status: 'running',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/png',
          name: 'large-enough.png',
        },
      ],
    });
  });

  it('materializes session image attachments as local tool paths without polluting the user prompt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moxxy-office-media-'));
    vi.stubEnv('MOXXY_HOME', home);
    try {
      const session = makeCodexSession({ supportsImages: true });
      const capture = captureMode(session);
      const res = makeResponse();
      const imageBytes = Buffer.from('office image bytes');

      await handleAgentRun(
        makeIncoming({
          method: 'POST',
          url: '/v1/agents/session/runs',
          headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
          body: JSON.stringify({
            task: 'Use this image in a local tool',
            attachments: [
              {
                kind: 'image',
                content: imageBytes.toString('base64'),
                mediaType: 'image/png',
                name: '../my photo.png',
              },
            ],
          }),
        }),
        res,
        ctx(session),
      );

      expect(res._status).toBe(200);
      await vi.waitFor(() => expect(capture.getSystemPrompt() ?? '').toContain('Virtual Office uploaded image attachments'));
      const materializedPath = materializedPathFromPrompt(capture.getSystemPrompt());

      expect(materializedPath.startsWith(join(home, 'media', String(session.id)))).toBe(true);
      expect(materializedPath).toContain('my-photo.png');
      expect(await readFile(materializedPath)).toEqual(imageBytes);
      expect(session.log.ofType('user_prompt')[0]?.text).toBe('Use this image in a local tool');
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('materializes office agent image attachments as local tool paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'moxxy-office-agent-media-'));
    vi.stubEnv('MOXXY_HOME', home);
    try {
      const session = makeCodexSession({ supportsImages: true });
      const capture = captureMode(session);
      const runtime = new OfficeAgentRuntime(session, silentLogger);
      const agent = await runtime.create({ name: 'designer' });
      const res = makeResponse();
      const imageBytes = Buffer.from('office agent image bytes');

      await handleAgentRun(
        makeIncoming({
          method: 'POST',
          url: `/v1/agents/${agent.id}/runs`,
          headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
          body: JSON.stringify({
            task: 'Edit this reference image',
            attachments: [
              {
                kind: 'image',
                content: imageBytes.toString('base64'),
                mediaType: 'image/png',
                name: 'reference.png',
              },
            ],
          }),
        }),
        res,
        { ...ctx(session), officeAgents: runtime },
      );

      expect(res._status).toBe(200);
      await vi.waitFor(() => expect(capture.getSystemPrompt() ?? '').toContain('Virtual Office uploaded image attachments'));
      const materializedPath = materializedPathFromPrompt(capture.getSystemPrompt());

      expect(materializedPath.startsWith(join(home, 'media', String(session.id)))).toBe(true);
      expect(materializedPath).toContain('reference.png');
      expect(await readFile(materializedPath)).toEqual(imageBytes);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
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

describe('handleMediaPreview', () => {
  const ctx = (session: Session) => ({ session, authToken: 'x', logger: silentLogger });

  async function tempFile(name: string, bytes: Buffer | string): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'moxxy-media-preview-'));
    const path = join(dir, name);
    await writeFile(path, bytes);
    return { dir, path };
  }

  async function referenceImage(session: Session, source: string): Promise<void> {
    await session.log.append({
      type: 'assistant_message',
      sessionId: session.id,
      turnId: session.startTurn().turnId,
      source: 'assistant',
      content: `Generated image: ![preview](${source})`,
    });
  }

  it('requires auth when the bridge is token protected', async () => {
    const session = new Session({ cwd: '/tmp', silent: true });
    const res = makeResponse();

    await handleMediaPreview(
      makeIncoming({ method: 'GET', url: '/v1/media/preview?source=/tmp/missing.png' }),
      res,
      ctx(session),
    );

    expect(res._status).toBe(401);
  });

  it('serves a referenced local image as bytes', async () => {
    const { dir, path } = await tempFile('render.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const session = new Session({ cwd: dir, silent: true });
      await referenceImage(session, pathToFileURL(path).href);
      const res = makeResponse();

      await handleMediaPreview(
        makeIncoming({
          method: 'GET',
          url: `/v1/media/preview?source=${encodeURIComponent(pathToFileURL(path).href)}`,
          headers: { authorization: 'Bearer x' },
        }),
        res,
        ctx(session),
      );

      expect(res._status).toBe(200);
      expect(res._headers['content-type']).toBe('image/png');
      expect(res._rawBody).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects local images that were not referenced by the current session log', async () => {
    const { dir, path } = await tempFile('private.png', 'png');
    try {
      const session = new Session({ cwd: dir, silent: true });
      const res = makeResponse();

      await handleMediaPreview(
        makeIncoming({
          method: 'GET',
          url: `/v1/media/preview?source=${encodeURIComponent(path)}`,
          headers: { authorization: 'Bearer x' },
        }),
        res,
        ctx(session),
      );

      expect(res._status).toBe(403);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns 404 for a referenced image path that no longer exists', async () => {
    const { dir, path } = await tempFile('gone.png', 'png');
    await rm(path, { force: true });
    try {
      const session = new Session({ cwd: dir, silent: true });
      await referenceImage(session, path);
      const res = makeResponse();

      await handleMediaPreview(
        makeIncoming({
          method: 'GET',
          url: `/v1/media/preview?source=${encodeURIComponent(path)}`,
          headers: { authorization: 'Bearer x' },
        }),
        res,
        ctx(session),
      );

      expect(res._status).toBe(404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-image local files even if they were referenced', async () => {
    const { dir, path } = await tempFile('notes.txt', 'hello');
    try {
      const session = new Session({ cwd: dir, silent: true });
      await referenceImage(session, path);
      const res = makeResponse();

      await handleMediaPreview(
        makeIncoming({
          method: 'GET',
          url: `/v1/media/preview?source=${encodeURIComponent(path)}`,
          headers: { authorization: 'Bearer x' },
        }),
        res,
        ctx(session),
      );

      expect(res._status).toBe(415);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects referenced image files above the preview size limit', async () => {
    const bytes = Buffer.alloc((10 * 1024 * 1024) + 1, 1);
    const { dir, path } = await tempFile('huge.jpg', bytes);
    try {
      expect((await stat(path)).size).toBeGreaterThan(10 * 1024 * 1024);
      const session = new Session({ cwd: dir, silent: true });
      await referenceImage(session, path);
      const res = makeResponse();

      await handleMediaPreview(
        makeIncoming({
          method: 'GET',
          url: `/v1/media/preview?source=${encodeURIComponent(path)}`,
          headers: { authorization: 'Bearer x' },
        }),
        res,
        ctx(session),
      );

      expect(res._status).toBe(413);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
