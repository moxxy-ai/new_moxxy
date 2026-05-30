import { promises as fsp, type FSWatcher, watch as fsWatch } from 'node:fs';
import * as path from 'node:path';
import { createSubagentSpawner, type Session } from '@moxxy/core';
import {
  asPluginId,
  moxxyPath,
  writeFileAtomic,
  type EmittedEvent,
  type MoxxyEvent,
  type Plugin,
  type Workflow,
  type WorkflowRunResult,
  type WorkflowsView,
} from '@moxxy/sdk';
import type { ScheduleStore } from '@moxxy/plugin-scheduler';
import {
  BUILTIN_WORKFLOWS_DIR,
  WORKFLOWS_PLUGIN_NAME,
  WorkflowStore,
  buildWorkflowsPlugin,
  defaultUserWorkflowsDir,
  draftWorkflow,
  resumeWorkflowRun,
  runWorkflow,
  validateWorkflow,
} from '@moxxy/plugin-workflows';

/**
 * Wire the workflows plugin to the live Session. Mirrors the scheduler/webhooks
 * wiring: build a `WorkflowStore`, an autonomous runner (a subagent spawner +
 * the engine), a `WorkflowsView` for the `/workflows` modal, and the trigger
 * subsystem — schedules are mirrored into the shared scheduler poller (zero new
 * timers); `afterWorkflow` keys off the `workflow_completed` event; `fileChanged`
 * uses fs.watch. Returns the plugin entry plus a `stop()` for the watchers.
 */

interface MiniLogger {
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface WorkflowsIntegration {
  readonly plugin: Plugin;
  readonly store: WorkflowStore;
  stop(): void;
}

const PLUGIN_ID = asPluginId(WORKFLOWS_PLUGIN_NAME);

export function buildWorkflowsIntegration(args: {
  session: Session;
  scheduleStore: ScheduleStore;
  userWorkflowsDir?: string;
  projectWorkflowsDir?: string;
  logger?: MiniLogger;
}): WorkflowsIntegration {
  const { session, scheduleStore, logger } = args;
  const store = new WorkflowStore({
    cwd: session.cwd,
    ...(args.userWorkflowsDir ? { userDir: args.userWorkflowsDir } : {}),
    ...(args.projectWorkflowsDir ? { projectDir: args.projectWorkflowsDir } : {}),
    builtinDir: BUILTIN_WORKFLOWS_DIR,
    ...(logger ? { logger } : {}),
  });

  const watchers: FSWatcher[] = [];
  const fileDebounceTimers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<string>();

  // --- the autonomous runner: spawner + engine + inbox delivery ---
  async function runNow(input: {
    name: string;
    inputs?: Record<string, unknown>;
    trigger?: string;
  }): Promise<WorkflowRunResult> {
    const entry = await store.get(input.name);
    if (!entry) {
      return { ok: false, status: 'failed', steps: [], output: '', error: `no workflow named "${input.name}"` };
    }
    if (inFlight.has(input.name)) {
      return {
        ok: false,
        status: 'failed',
        steps: [],
        output: '',
        error: `workflow "${input.name}" is already running`,
      };
    }
    inFlight.add(input.name);
    try {
      const turnId = session.startTurn().turnId;
      const spawner = createSubagentSpawner({
        parentSession: session,
        parentTurnId: turnId,
        parentSignal: session.signal,
        parentModel: activeModel(session),
      });
      const result = await runWorkflow(
        entry.workflow,
        {
          spawner,
          tools: session.tools,
          lookup: {
            skill: (n) => session.skills.byName(n),
            workflow: (n) => store.lookup(n),
          },
          signal: session.signal,
          ...(input.inputs ? { inputs: input.inputs } : {}),
          trigger: input.trigger ?? 'auto',
          now: () => Date.now(),
          emit: (subtype, payload) =>
            void session.log.append({
              type: 'plugin_event',
              sessionId: session.id,
              turnId,
              source: 'plugin',
              pluginId: PLUGIN_ID,
              subtype,
              payload,
            } as EmittedEvent),
          ...(logger ? { logger } : {}),
        },
        { executor: session.workflowExecutors.getActive() },
      );
      await deliverToInbox(entry.workflow, result, logger);
      return result;
    } finally {
      inFlight.delete(input.name);
    }
  }

  // --- the /workflows modal view ---
  async function workflowDetail(
    entry: { workflow: Workflow; scope: string; path: string },
    includeYaml = false,
  ): Promise<NonNullable<Awaited<ReturnType<WorkflowsView['get']>>>> {
    let yaml: string | undefined;
    if (includeYaml) {
      try {
        yaml = await fsp.readFile(entry.path, 'utf8');
      } catch {
        yaml = undefined;
      }
    }
    return {
      workflow: entry.workflow,
      scope: entry.scope,
      path: entry.path,
      ...(yaml !== undefined ? { yaml } : {}),
    };
  }

  async function resyncTriggers(): Promise<void> {
    await syncSchedules();
    await startFileWatchers();
  }

  const view: WorkflowsView = {
    list: async () =>
      (await store.list()).map((w) => ({
        name: w.workflow.name,
        description: w.workflow.description,
        enabled: w.workflow.enabled,
        scope: w.scope,
        steps: w.workflow.steps.length,
        triggers: triggerSummary(w.workflow.on),
      })),
    get: async (name) => {
      const entry = await store.get(name);
      return entry ? workflowDetail(entry, true) : null;
    },
    create: async (workflow, scope = 'user') => {
      const parsed = validateWorkflow(workflow);
      if (!parsed.ok || !parsed.workflow) throw new Error(parsed.errors.join('\n') || 'invalid workflow');
      const entry = await store.create(parsed.workflow, scope);
      await resyncTriggers();
      return workflowDetail(entry, true);
    },
    update: async (name, workflow) => {
      if (workflow.name !== name) {
        throw new Error(`workflow name mismatch: URL targets "${name}" but body contains "${workflow.name}"`);
      }
      const parsed = validateWorkflow(workflow);
      if (!parsed.ok || !parsed.workflow) throw new Error(parsed.errors.join('\n') || 'invalid workflow');
      const existing = await store.get(name);
      if (!existing) throw new Error(`no workflow named "${name}"`);
      const entry = await store.save(parsed.workflow);
      await resyncTriggers();
      return workflowDetail(entry, true);
    },
    delete: async (name) => {
      const result = await store.delete(name);
      if (result.ok) await resyncTriggers();
      return result;
    },
    validate: async (workflow) => {
      const result = validateWorkflow(workflow);
      return { ok: result.ok, errors: result.errors };
    },
    draft: async (intent) => {
      const provider = safeActiveProvider(session);
      if (!provider) {
        return { workflow: null, raw: '', errors: ['no active provider is available to draft workflows'] };
      }
      const drafted = await draftWorkflow(provider, activeModel(session), intent, session.signal, {
        availableSkills: session.skills.list().map((s) => ({
          name: s.frontmatter.name,
          description: s.frontmatter.description ?? '',
        })),
        availableTools: session.tools.list().map((t) => ({
          name: t.name,
          description: t.description ?? '',
        })),
        maxTokens: 4096,
      });
      return {
        workflow: drafted.parse.workflow ?? null,
        raw: drafted.raw,
        errors: drafted.parse.errors,
      };
    },
    capabilities: async () => {
      const toolEntries = session.tools.list().map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
      }));
      const mcp = toolEntries.filter((tool) => tool.name.startsWith('mcp__'));
      const tools = toolEntries.filter((tool) => !tool.name.startsWith('mcp__'));
      return {
        skills: session.skills.list().map((skill) => ({
          name: skill.frontmatter.name,
          description: skill.frontmatter.description,
        })),
        tools,
        mcp,
        workflows: (await store.list()).map(({ workflow }) => ({
          name: workflow.name,
          description: workflow.description,
        })),
      };
    },
    setEnabled: async (name, enabled) => {
      const updated = await store.setEnabled(name, enabled);
      if (!updated) throw new Error(`no workflow named "${name}"`);
      await resyncTriggers();
    },
    run: async (name, inputs) => {
      const r = await runNow({ name, trigger: 'manual', ...(inputs ? { inputs } : {}) });
      return formatWorkflowRunView(r);
    },
    runInline: async (workflow, inputs) => {
      const r = await runInlineWorkflow(workflow, 'manual', inputs);
      return formatWorkflowRunView(r);
    },
    reply,
  };

  async function runInlineWorkflow(
    workflow: Workflow,
    trigger: string,
    inputs?: Record<string, unknown>,
  ): Promise<WorkflowRunResult> {
    const runKey = `inline:${workflow.name}`;
    if (inFlight.has(runKey)) {
      return {
        ok: false,
        status: 'failed',
        steps: [],
        output: '',
        error: `workflow "${workflow.name}" is already running`,
      };
    }
    inFlight.add(runKey);
    try {
      const turnId = session.startTurn().turnId;
      const spawner = createSubagentSpawner({
        parentSession: session,
        parentTurnId: turnId,
        parentSignal: session.signal,
        parentModel: activeModel(session),
      });
      return await runWorkflow(
        workflow,
        {
          spawner,
          tools: session.tools,
          lookup: {
            skill: (n) => session.skills.byName(n),
            workflow: (n) => store.lookup(n),
          },
          signal: session.signal,
          ...(inputs ? { inputs } : {}),
          trigger,
          now: () => Date.now(),
          emit: (subtype, payload) =>
            void session.log.append({
              type: 'plugin_event',
              sessionId: session.id,
              turnId,
              source: 'plugin',
              pluginId: PLUGIN_ID,
              subtype,
              payload,
            } as EmittedEvent),
          ...(logger ? { logger } : {}),
        },
        { executor: session.workflowExecutors.getActive() },
      );
    } finally {
      inFlight.delete(runKey);
    }
  }

  async function reply(runId: string, message: string) {
    const turnId = session.startTurn().turnId;
    const spawner = createSubagentSpawner({
      parentSession: session,
      parentTurnId: turnId,
      parentSignal: session.signal,
      parentModel: activeModel(session),
    });
    const r = await resumeWorkflowRun(
      runId,
      message,
      {
        spawner,
        tools: session.tools,
        lookup: {
          skill: (n) => session.skills.byName(n),
          workflow: (n) => store.lookup(n),
        },
        signal: session.signal,
        trigger: 'manual',
        now: () => Date.now(),
        emit: (subtype, payload) =>
          void session.log.append({
            type: 'plugin_event',
            sessionId: session.id,
            turnId,
            source: 'plugin',
            pluginId: PLUGIN_ID,
            subtype,
            payload,
          } as EmittedEvent),
        ...(logger ? { logger } : {}),
      },
    );
    return formatWorkflowRunView(r);
  }

  function formatWorkflowRunView(r: WorkflowRunResult) {
    return {
      ok: r.ok,
      status: r.status,
      output: r.output,
      ...(r.error ? { error: r.error } : {}),
      ...(r.runId ? { runId: r.runId } : {}),
      ...(r.pendingStepId ? { pendingStepId: r.pendingStepId } : {}),
      ...(r.interactionAgentId ? { interactionAgentId: r.interactionAgentId } : {}),
      steps: r.steps.map((s) => ({ id: s.id, status: s.status, ...(s.error ? { error: s.error } : {}) })),
    };
  }

  // --- triggers ---
  async function syncSchedules(): Promise<void> {
    const all = await store.list();
    for (const { workflow } of all) {
      const sched = workflow.enabled ? workflow.on?.schedule : undefined;
      if (sched && (sched.cron || sched.runAt)) {
        const runAt = typeof sched.runAt === 'string' ? Date.parse(sched.runAt) : sched.runAt;
        await scheduleStore.syncWorkflowSchedule(workflow.name, {
          id: `workflow:${workflow.name}`,
          name: `wf-${workflow.name}`.slice(0, 120),
          // The scheduled turn runs this prompt; the model calls workflow_run,
          // whose engine drives the DAG. Scheduler writes the result to inbox.
          prompt: `Run the "${workflow.name}" workflow now using the workflow_run tool, then briefly report what each step did.`,
          ...(sched.cron ? { cron: sched.cron } : {}),
          ...(runAt ? { runAt } : {}),
          ...(sched.timeZone ? { timeZone: sched.timeZone } : {}),
          enabled: true,
          createdAt: Date.now(),
          source: 'workflow',
          workflowName: workflow.name,
        });
      } else {
        await scheduleStore.syncWorkflowSchedule(workflow.name, null);
      }
      // fileChanged / webhook triggers are recognized but auto-firing for them
      // is wired separately (fileChanged below; webhook is a follow-up).
      if (workflow.enabled && workflow.on?.webhook) {
        logger?.warn?.('workflows: webhook triggers are not auto-fired yet; run on demand', {
          workflow: workflow.name,
        });
      }
    }
  }

  // afterWorkflow: when a workflow completes, fire any enabled workflow that
  // lists it under `on.afterWorkflow`. Guards against direct self-trigger.
  const unsubscribe = session.log.subscribe((event: MoxxyEvent) => {
    if (event.type !== 'plugin_event' || event.subtype !== 'workflow_completed') return;
    const completed = (event.payload as { name?: string } | undefined)?.name;
    if (!completed) return;
    void (async () => {
      for (const { workflow } of await store.list()) {
        if (!workflow.enabled || !workflow.on?.afterWorkflow) continue;
        const deps = [workflow.on.afterWorkflow].flat();
        if (deps.includes(completed) && workflow.name !== completed) {
          logger?.info?.('workflows: afterWorkflow trigger', { workflow: workflow.name, after: completed });
          await runNow({ name: workflow.name, trigger: `after:${completed}` }).catch((err) =>
            logger?.warn?.('workflows: afterWorkflow run failed', {
              workflow: workflow.name,
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    })();
  });

  async function startFileWatchers(): Promise<void> {
    for (const w of watchers.splice(0)) w.close();
    for (const timer of fileDebounceTimers.values()) clearTimeout(timer);
    fileDebounceTimers.clear();
    for (const { workflow } of await store.list()) {
      if (!workflow.enabled || !workflow.on?.fileChanged) continue;
      for (const glob of [workflow.on.fileChanged].flat()) {
        const base = globBaseDir(glob, session.cwd);
        try {
          const watcher = fsWatch(base, { recursive: true }, () => {
            const prev = fileDebounceTimers.get(workflow.name);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
              void runNow({ name: workflow.name, trigger: `fileChanged:${glob}` }).catch(() => {});
            }, 600);
            t.unref?.();
            fileDebounceTimers.set(workflow.name, t);
          });
          watchers.push(watcher);
        } catch (err) {
          logger?.warn?.('workflows: cannot watch path', {
            workflow: workflow.name,
            base,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const built = buildWorkflowsPlugin({
    store,
    skills: session.skills,
    tools: session.tools,
    getActiveExecutor: () => session.workflowExecutors.getActive(),
    appendEvent: (e) => session.log.append(e),
    ...(logger ? { logger } : {}),
    provider: () => safeActiveProvider(session),
    listSkills: () => session.skills.list().map((s) => ({
      name: s.frontmatter.name,
      description: s.frontmatter.description ?? '',
    })),
    listTools: () => session.tools.list().map((t) => ({
      name: t.name,
      description: t.description ?? '',
    })),
    onChanged: resyncTriggers,
    runNow,
    userDir: defaultUserWorkflowsDir(),
    onReady: async () => {
      session.workflows = view;
      await resyncTriggers();
    },
  });

  return {
    plugin: built.plugin,
    store,
    stop: () => {
      unsubscribe();
      for (const w of watchers.splice(0)) w.close();
      for (const timer of fileDebounceTimers.values()) clearTimeout(timer);
      fileDebounceTimers.clear();
    },
  };
}

function activeModel(session: Session): string {
  return safeActiveProvider(session)?.models[0]?.id ?? 'claude-sonnet-4-6';
}

function safeActiveProvider(session: Session): ReturnType<Session['providers']['getActive']> | null {
  try {
    return session.providers.getActive();
  } catch {
    return null;
  }
}

function triggerSummary(on: import('@moxxy/sdk').WorkflowTrigger | undefined): string {
  if (!on) return 'on-demand';
  const parts: string[] = [];
  if (on.schedule?.cron) parts.push(`cron(${on.schedule.cron})`);
  if (on.schedule?.runAt) parts.push('runAt');
  if (on.afterWorkflow) parts.push(`after(${[on.afterWorkflow].flat().join(',')})`);
  if (on.fileChanged) parts.push('fileChanged');
  if (on.webhook) parts.push(`webhook(${on.webhook})`);
  return parts.length > 0 ? parts.join('+') : 'on-demand';
}

/** Strip a glob down to its watchable base directory (everything before `*`). */
function globBaseDir(glob: string, cwd: string): string {
  const star = glob.indexOf('*');
  const head = star >= 0 ? glob.slice(0, star) : glob;
  const dir = head.includes('/') ? head.slice(0, head.lastIndexOf('/')) : '';
  return path.resolve(cwd, dir || '.');
}

async function deliverToInbox(
  workflow: import('@moxxy/sdk').Workflow,
  result: WorkflowRunResult,
  logger?: MiniLogger,
): Promise<void> {
  if (workflow.delivery && workflow.delivery.inbox === false) return;
  try {
    const dir = moxxyPath('inbox');
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${workflow.name}.md`);
    const header = [
      '---',
      `workflow: ${workflow.name}`,
      `firedAt: ${new Date().toISOString()}`,
      workflow.delivery?.channel ? `channel: ${workflow.delivery.channel}` : null,
      `outcome: ${result.ok ? 'ok' : 'error'}`,
      '---',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
    const body = result.error ? `**error:** ${result.error}\n\n${result.output}` : result.output;
    await writeFileAtomic(file, header + body + '\n');
  } catch (err) {
    logger?.warn?.('workflows: inbox delivery failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
