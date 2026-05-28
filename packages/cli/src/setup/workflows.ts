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
  runWorkflow,
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
  logger?: MiniLogger;
}): WorkflowsIntegration {
  const { session, scheduleStore, logger } = args;
  const store = new WorkflowStore({
    cwd: session.cwd,
    builtinDir: BUILTIN_WORKFLOWS_DIR,
    ...(logger ? { logger } : {}),
  });

  const watchers: FSWatcher[] = [];
  const inFlight = new Set<string>();

  // --- the autonomous runner: spawner + engine + inbox delivery ---
  async function runNow(input: {
    name: string;
    inputs?: Record<string, unknown>;
    trigger?: string;
  }): Promise<WorkflowRunResult> {
    const entry = await store.get(input.name);
    if (!entry) return { ok: false, steps: [], output: '', error: `no workflow named "${input.name}"` };
    if (inFlight.has(input.name)) {
      return { ok: false, steps: [], output: '', error: `workflow "${input.name}" is already running` };
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
    setEnabled: async (name, enabled) => {
      await store.setEnabled(name, enabled);
      await syncSchedules();
    },
    run: async (name) => {
      const r = await runNow({ name, trigger: 'manual' });
      return {
        ok: r.ok,
        output: r.output,
        ...(r.error ? { error: r.error } : {}),
        steps: r.steps.map((s) => ({ id: s.id, status: s.status, ...(s.error ? { error: s.error } : {}) })),
      };
    },
  };

  // --- triggers ---
  async function syncSchedules(): Promise<void> {
    const all = await store.list();
    for (const { workflow } of all) {
      const sched = workflow.enabled ? workflow.on?.schedule : undefined;
      if (sched && (sched.cron || sched.runAt)) {
        const runAt = typeof sched.runAt === 'string' ? Date.parse(sched.runAt) : sched.runAt;
        await scheduleStore.syncWorkflowSchedule(workflow.name, {
          id: '',
          name: `wf-${workflow.name}`.slice(0, 120),
          // The scheduled turn runs this prompt; the model calls workflow_run,
          // whose engine drives the DAG. Scheduler writes the result to inbox.
          prompt: `Run the "${workflow.name}" workflow now using the workflow_run tool, then briefly report what each step did.`,
          ...(sched.cron ? { cron: sched.cron } : {}),
          ...(runAt ? { runAt } : {}),
          ...(sched.timeZone ? { timeZone: sched.timeZone } : {}),
          enabled: true,
          createdAt: 0,
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
    const debounced = new Map<string, NodeJS.Timeout>();
    for (const { workflow } of await store.list()) {
      if (!workflow.enabled || !workflow.on?.fileChanged) continue;
      for (const glob of [workflow.on.fileChanged].flat()) {
        const base = globBaseDir(glob, session.cwd);
        try {
          const watcher = fsWatch(base, { recursive: true }, () => {
            const prev = debounced.get(workflow.name);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
              void runNow({ name: workflow.name, trigger: `fileChanged:${glob}` }).catch(() => {});
            }, 600);
            t.unref?.();
            debounced.set(workflow.name, t);
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
    listSkills: () => session.skills.list().map((s) => s.frontmatter.name),
    listTools: () => session.tools.list().map((t) => t.name),
    onChanged: syncSchedules,
    runNow,
    userDir: defaultUserWorkflowsDir(),
    onReady: async () => {
      session.workflows = view;
      await syncSchedules();
      await startFileWatchers();
    },
  });

  return {
    plugin: built.plugin,
    store,
    stop: () => {
      unsubscribe();
      for (const w of watchers.splice(0)) w.close();
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
