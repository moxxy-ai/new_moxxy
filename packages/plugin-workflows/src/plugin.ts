import {
  definePlugin,
  type EmittedEvent,
  type LLMProvider,
  type Plugin,
  type Skill,
  type WorkflowExecutorDef,
  type WorkflowRunResult,
  type WorkflowToolRunner,
} from '@moxxy/sdk';
import { buildWorkflowsCommand } from './command.js';
import { dagExecutor } from './executor/dag.js';
import type { WorkflowLogger } from './loader.js';
import { buildWorkflowTools, WORKFLOWS_PLUGIN_NAME, type WorkflowToolDeps } from './tools.js';
import type { WorkflowStore } from './store.js';

/**
 * Assemble the workflows plugin. Mirrors `buildSchedulerPlugin`: the CLI
 * supplies dependencies bound to the live `Session` (kept as SDK-typed
 * closures so this package never imports `@moxxy/core`). Returns the plugin
 * plus the shared `WorkflowStore` so the CLI can build the `WorkflowsView`
 * (for the `/workflows` modal) and the autonomous runner against the same
 * instance.
 */
export interface BuildWorkflowsPluginOptions {
  readonly store: WorkflowStore;
  readonly skills: { byName(name: string): Skill | undefined };
  readonly tools: WorkflowToolRunner;
  readonly getActiveExecutor: () => WorkflowExecutorDef | null;
  readonly appendEvent?: (event: EmittedEvent) => unknown;
  readonly logger?: WorkflowLogger;
  readonly runRecordDir?: string | null;
  readonly provider?: () => LLMProvider | null;
  readonly draftModel?: string;
  readonly listSkills?: () => ReadonlyArray<string>;
  readonly listTools?: () => ReadonlyArray<string>;
  /** Re-sync triggers after a create/update/delete/toggle. */
  readonly onChanged?: () => void | Promise<void>;
  /** Runs a workflow now (autonomous runner) — backs `/workflows run`. */
  readonly runNow?: (input: {
    readonly name: string;
    readonly inputs?: Record<string, unknown>;
    readonly trigger?: string;
  }) => Promise<WorkflowRunResult>;
  readonly userDir?: string;
  /** Called once after the store has loaded on init (CLI installs view + triggers here). */
  readonly onReady?: () => void | Promise<void>;
}

export function buildWorkflowsPlugin(opts: BuildWorkflowsPluginOptions): {
  readonly plugin: Plugin;
  readonly store: WorkflowStore;
} {
  const toolDeps: WorkflowToolDeps = {
    store: opts.store,
    skills: opts.skills,
    tools: opts.tools,
    getActiveExecutor: opts.getActiveExecutor,
    ...(opts.appendEvent ? { appendEvent: opts.appendEvent } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.runRecordDir !== undefined ? { runRecordDir: opts.runRecordDir } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.draftModel ? { draftModel: opts.draftModel } : {}),
    ...(opts.listSkills ? { listSkills: opts.listSkills } : {}),
    ...(opts.listTools ? { listTools: opts.listTools } : {}),
    ...(opts.onChanged ? { onChanged: opts.onChanged } : {}),
  };

  const command = buildWorkflowsCommand({
    store: opts.store,
    ...(opts.runNow ? { runNow: opts.runNow } : {}),
    ...(opts.onChanged ? { onChanged: opts.onChanged } : {}),
    ...(opts.runRecordDir ? { runRecordDir: opts.runRecordDir } : {}),
    ...(opts.userDir ? { userDir: opts.userDir } : {}),
  });

  const plugin = definePlugin({
    name: WORKFLOWS_PLUGIN_NAME,
    version: '0.0.1',
    tools: buildWorkflowTools(toolDeps),
    workflowExecutors: [dagExecutor],
    commands: [command],
    hooks: {
      onInit: async () => {
        await opts.store.load();
        await opts.onReady?.();
      },
    },
  });

  return { plugin, store: opts.store };
}
