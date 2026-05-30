import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin, defineTool, z, type Workflow, type WorkflowsView } from '@moxxy/sdk';
import { SchedulerPoller, ScheduleStore } from '@moxxy/plugin-scheduler';
import { buildWorkflowsIntegration } from './workflows.js';

type GuiWorkflowsView = WorkflowsView & {
  create(workflow: Workflow, scope?: 'user' | 'project'): Promise<{ workflow: Workflow; scope: string }>;
  get(name: string): Promise<{ workflow: Workflow; scope: string } | null>;
  update(name: string, workflow: Workflow): Promise<{ workflow: Workflow; scope: string }>;
  delete(name: string): Promise<{ ok: boolean; reason?: string }>;
  validate(workflow: unknown): Promise<{ ok: boolean; errors: ReadonlyArray<string> }>;
  draft(intent: string): Promise<{ workflow: Workflow | null; raw: string; errors: ReadonlyArray<string> }>;
  capabilities(): Promise<{
    skills: ReadonlyArray<{ name: string; description: string }>;
    tools: ReadonlyArray<{ name: string; description: string }>;
    mcp: ReadonlyArray<{ name: string; description: string }>;
    workflows: ReadonlyArray<{ name: string; description: string }>;
  }>;
};

let dir: string;
let session: Session;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'moxxy-workflows-view-'));
  session = new Session({ cwd: dir, silent: true, logger: silentLogger });
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'workflow-view-test-tools',
      tools: [
        defineTool({
          name: 'echo_json',
          description: 'Echoes input for workflow tests',
          inputSchema: z.record(z.unknown()).default({}),
          handler: (input) => ({ ok: true, input }),
        }),
      ],
    }),
  );
});

afterEach(async () => {
  await session?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function bootView(scheduleStore = new ScheduleStore({ file: join(dir, 'schedules.json') })): Promise<GuiWorkflowsView> {
  const integration = buildWorkflowsIntegration({
    session,
    scheduleStore,
    userWorkflowsDir: join(dir, 'user-workflows'),
    projectWorkflowsDir: join(dir, 'project-workflows'),
    logger: silentLogger,
  });
  session.pluginHost.registerStatic(integration.plugin);
  await integration.plugin.hooks?.onInit?.(session.appContext());
  expect(session.workflows).toBeDefined();
  return session.workflows as GuiWorkflowsView;
}

function sampleWorkflow(name = 'office-flow'): Workflow {
  return {
    name,
    description: 'Workflow edited from Virtual Office.',
    version: 1,
    enabled: true,
    inputs: {},
    concurrency: 2,
    on: { schedule: { cron: '0 9 * * 1-5', timeZone: 'Europe/Warsaw' } },
    steps: [
      {
        id: 'prepare',
        tool: 'echo_json',
        args: { text: 'hello' },
        needs: [],
        onError: 'fail',
        retries: 0,
      },
    ],
    ui: {
      layout: {
        nodes: { prepare: { x: 100, y: 140 } },
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  };
}

describe('buildWorkflowsIntegration WorkflowsView', () => {
  it('supports GUI CRUD, validation, capabilities and real workflow runs', async () => {
    const view = await bootView();

    expect(await view.validate({ ...sampleWorkflow(), steps: [{ id: 'x' }] })).toMatchObject({
      ok: false,
    });

    const created = await view.create(sampleWorkflow(), 'user');
    expect(created.scope).toBe('user');
    expect(created.workflow.ui?.layout.nodes.prepare).toEqual({ x: 100, y: 140 });

    await expect(view.create(sampleWorkflow(), 'user')).rejects.toThrow(/already exists/);

    const capabilities = await view.capabilities();
    expect(capabilities.tools.map((tool) => tool.name)).toContain('echo_json');
    expect(capabilities.mcp.every((tool) => tool.name.startsWith('mcp__'))).toBe(true);
    expect(capabilities.tools.every((tool) => !tool.name.startsWith('mcp__'))).toBe(true);
    expect(capabilities.workflows.map((workflow) => workflow.name)).toContain('office-flow');

    const updated = await view.update('office-flow', {
      ...created.workflow,
      description: 'Updated from the desktop builder.',
      enabled: false,
    });
    expect(updated.workflow.description).toBe('Updated from the desktop builder.');
    expect((await view.get('office-flow'))?.workflow.enabled).toBe(false);

    await view.setEnabled('office-flow', true);
    expect((await view.list()).find((workflow) => workflow.name === 'office-flow')?.enabled).toBe(true);

    const run = await view.run('office-flow');
    expect(run.ok).toBe(true);
    expect(run.steps).toEqual([{ id: 'prepare', status: 'completed' }]);

    expect(await view.delete('office-flow')).toEqual({ ok: true });
    expect(await view.get('office-flow')).toBeNull();
  });

  it('does not fire a freshly mirrored cron workflow immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    const scheduleStore = new ScheduleStore({ file: join(dir, 'schedules.json') });
    const view = await bootView(scheduleStore);

    await view.create(sampleWorkflow(), 'user');

    const runner = { runPrompt: vi.fn(async () => ({ text: 'ran' })) };
    const poller = new SchedulerPoller({
      store: scheduleStore,
      runner,
      inbox: { dir: join(dir, 'inbox') },
      logger: silentLogger,
    });

    await expect(poller.tickOnce()).resolves.toBe(0);
    expect(runner.runPrompt).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
