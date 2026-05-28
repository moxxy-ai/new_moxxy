import {
  asPluginId,
  defineTool,
  MoxxyError,
  z,
  type EmittedEvent,
  type LLMProvider,
  type SessionId,
  type Skill,
  type ToolDef,
  type TurnId,
  type WorkflowEventSubtype,
  type WorkflowExecutorDef,
  type WorkflowRunDeps,
  type WorkflowToolRunner,
} from '@moxxy/sdk';
import { draftWorkflow } from './draft.js';
import { runWorkflow } from './engine.js';
import { parseWorkflowYaml, serializeWorkflow } from './schema.js';
import type { EditableScope, WorkflowStore } from './store.js';
import type { WorkflowLogger } from './loader.js';

export const WORKFLOWS_PLUGIN_NAME = '@moxxy/plugin-workflows';

/**
 * Dependencies the workflow tools close over. Supplied by the CLI wiring,
 * which binds them to the live `Session` — keeping this package free of any
 * `@moxxy/core` import (mirrors how `@moxxy/plugin-scheduler` takes an
 * injected runner + an SDK `SkillRegistry`).
 */
export interface WorkflowToolDeps {
  readonly store: WorkflowStore;
  readonly skills: { byName(name: string): Skill | undefined };
  readonly tools: WorkflowToolRunner;
  readonly getActiveExecutor: () => WorkflowExecutorDef | null;
  /** Bound to `session.log.append` so lifecycle events land on the log. */
  readonly appendEvent?: (event: EmittedEvent) => unknown;
  readonly logger?: WorkflowLogger;
  /** Run-record directory, or null to skip recording (tests). */
  readonly runRecordDir?: string | null;
  /** Active provider for `workflow_create` drafting. */
  readonly provider?: () => LLMProvider | null;
  readonly draftModel?: string;
  /** Skill/tool names surfaced to the drafter so it references real ones. */
  readonly listSkills?: () => ReadonlyArray<string>;
  readonly listTools?: () => ReadonlyArray<string>;
  /** Called after a create/update/delete/toggle so triggers can re-sync. */
  readonly onChanged?: () => void | Promise<void>;
}

const PLUGIN_ID = asPluginId(WORKFLOWS_PLUGIN_NAME);

/**
 * Build a {@link WorkflowRunDeps} for an in-turn run. The spawner comes from
 * the tool context (only present inside a run-turn loop); lifecycle events are
 * tagged to the current turn so the TUI threads them correctly.
 */
export function buildRunDeps(
  deps: WorkflowToolDeps,
  ctx: { sessionId: import('@moxxy/sdk').SessionId; turnId: import('@moxxy/sdk').TurnId; signal: AbortSignal; subagents: NonNullable<import('@moxxy/sdk').WorkflowRunDeps['spawner']> },
  inputs: Record<string, unknown> | undefined,
  trigger: string,
): WorkflowRunDeps {
  const emit = deps.appendEvent
    ? (subtype: WorkflowEventSubtype, payload: unknown) =>
        void deps.appendEvent!({
          type: 'plugin_event',
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          source: 'plugin',
          pluginId: PLUGIN_ID,
          subtype,
          payload,
        } as EmittedEvent)
    : undefined;
  return {
    spawner: ctx.subagents,
    tools: deps.tools,
    lookup: {
      skill: (n) => deps.skills.byName(n),
      workflow: (n) => deps.store.lookup(n),
    },
    signal: ctx.signal,
    ...(inputs ? { inputs } : {}),
    trigger,
    now: () => Date.now(),
    ...(emit ? { emit } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
}

export function buildWorkflowTools(deps: WorkflowToolDeps): ToolDef[] {
  return [
    runTool(deps),
    listTool(deps),
    getTool(deps),
    validateTool(deps),
    createTool(deps),
    updateTool(deps),
    setEnabledTool(deps),
    deleteTool(deps),
  ];
}

/** Append an artifact-change plugin_event (workflow_created/updated/deleted). */
function emitChange(
  deps: WorkflowToolDeps,
  ctx: { sessionId: SessionId; turnId: TurnId },
  subtype: string,
  payload: unknown,
): void {
  deps.appendEvent?.({
    type: 'plugin_event',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'plugin',
    pluginId: PLUGIN_ID,
    subtype,
    payload,
  } as EmittedEvent);
}

function createTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_create',
    description:
      'Draft and persist a new workflow from a natural-language intent (the agentic ' +
      'authoring path). Uses the active provider to generate a workflow YAML, validates ' +
      'it (schema + DAG + conditions), writes it, and registers it. ALWAYS pass scope="user" ' +
      '(default) unless the user explicitly asks to scope it to this project.',
    inputSchema: z.object({
      intent: z.string().min(1).describe('What the workflow should do. One or two sentences.'),
      scope: z.enum(['user', 'project']).optional().default('user'),
    }),
    permission: { action: 'prompt' },
    handler: async ({ intent, scope }, ctx) => {
      const provider = deps.provider?.();
      if (!provider) {
        throw new MoxxyError({ code: 'PROVIDER_NOT_CONFIGURED', message: 'workflow_create: no active provider to draft with.' });
      }
      const model = deps.draftModel ?? provider.models[0]?.id ?? 'claude-sonnet-4-6';
      const drafted = await draftWorkflow(provider, model, intent, ctx.signal, {
        ...(deps.listSkills ? { availableSkills: deps.listSkills() } : {}),
        ...(deps.listTools ? { availableTools: deps.listTools() } : {}),
      });
      if (!drafted.parse.ok || !drafted.parse.workflow) {
        throw new MoxxyError({
          code: 'TOOL_ERROR',
          message:
            `workflow_create: the model did not produce a valid workflow ` +
            `(${drafted.parse.errors.join('; ')}). Try a more specific intent.`,
        });
      }
      const created = await deps.store.create(drafted.parse.workflow, scope as EditableScope);
      emitChange(deps, ctx, 'workflow_created', { name: created.workflow.name, scope });
      await deps.onChanged?.();
      return { name: created.workflow.name, scope: created.scope, path: created.path, steps: created.workflow.steps.length };
    },
  });
}

function updateTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_update',
    description:
      'Replace a saved workflow with new YAML (full document). Validates before writing. ' +
      'Use workflow_get to fetch the current YAML, edit it, then pass it back here.',
    inputSchema: z.object({
      name: z.string().min(1),
      yaml: z.string().min(1).describe('The complete new workflow YAML.'),
    }),
    permission: { action: 'prompt' },
    handler: async ({ name, yaml }, ctx) => {
      const parsed = parseWorkflowYaml(yaml);
      if (!parsed.ok || !parsed.workflow) {
        throw new MoxxyError({ code: 'TOOL_ERROR', message: `workflow_update: invalid YAML — ${parsed.errors.join('; ')}` });
      }
      if (parsed.workflow.name !== name) {
        throw new MoxxyError({ code: 'TOOL_ERROR', message: `workflow_update: YAML name "${parsed.workflow.name}" must match "${name}".` });
      }
      const saved = await deps.store.save(parsed.workflow);
      emitChange(deps, ctx, 'workflow_updated', { name });
      await deps.onChanged?.();
      return { name: saved.workflow.name, scope: saved.scope, path: saved.path };
    },
  });
}

function setEnabledTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_set_enabled',
    description:
      'Enable or disable a workflow. A disabled workflow keeps its definition but its ' +
      'triggers never fire and it is excluded from auto-runs (it can still be run explicitly).',
    inputSchema: z.object({ name: z.string().min(1), enabled: z.boolean() }),
    permission: { action: 'prompt' },
    handler: async ({ name, enabled }, ctx) => {
      const updated = await deps.store.setEnabled(name, enabled);
      if (!updated) throw new MoxxyError({ code: 'TOOL_ERROR', message: `workflow_set_enabled: no workflow "${name}".` });
      emitChange(deps, ctx, 'workflow_updated', { name, enabled });
      await deps.onChanged?.();
      return { name, enabled };
    },
  });
}

function deleteTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_delete',
    description: 'Delete a user/project workflow by name. Builtin/plugin workflows cannot be deleted.',
    inputSchema: z.object({ name: z.string().min(1) }),
    permission: { action: 'prompt' },
    handler: async ({ name }, ctx) => {
      const res = await deps.store.delete(name);
      if (!res.ok) throw new MoxxyError({ code: 'TOOL_ERROR', message: `workflow_delete: ${res.reason}.` });
      emitChange(deps, ctx, 'workflow_deleted', { name });
      await deps.onChanged?.();
      return { name, deleted: true };
    },
  });
}

function runTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_run',
    description:
      'Run a saved workflow now by name. Executes its DAG of skill/prompt/tool steps ' +
      'via the active workflow executor, piping each step\'s output into the next, and ' +
      'returns a per-step summary plus the final output. Pass `inputs` to override the ' +
      'workflow\'s declared input defaults.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Exact workflow name (see workflow_list).'),
      inputs: z.record(z.unknown()).optional().describe('Input overrides for this run.'),
    }),
    permission: { action: 'prompt' },
    handler: async ({ name, inputs }, ctx) => {
      const entry = await deps.store.get(name);
      if (!entry) {
        const known = (await deps.store.list()).map((w) => w.workflow.name).join(', ');
        throw new MoxxyError({
          code: 'TOOL_ERROR',
          message: `workflow_run: no workflow named "${name}". Known: ${known || '(none)'}.`,
        });
      }
      if (!ctx.subagents) {
        throw new MoxxyError({
          code: 'INTERNAL',
          message: 'workflow_run: no subagent spawner — must be invoked from a run-turn loop.',
        });
      }
      const runDeps = buildRunDeps(
        deps,
        { sessionId: ctx.sessionId, turnId: ctx.turnId, signal: ctx.signal, subagents: ctx.subagents },
        inputs,
        'manual',
      );
      const result = await runWorkflow(entry.workflow, runDeps, {
        executor: deps.getActiveExecutor(),
        ...(deps.runRecordDir !== undefined ? { recordDir: deps.runRecordDir } : {}),
      });
      return {
        ok: result.ok,
        output: result.output,
        steps: result.steps.map((s) => ({
          id: s.id,
          status: s.status,
          ...(s.error ? { error: s.error } : {}),
        })),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  });
}

function listTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_list',
    description: 'List all saved workflows with their status, scope, triggers, and step count.',
    inputSchema: z.object({}),
    permission: { action: 'allow' },
    handler: async () => {
      const all = await deps.store.list();
      return {
        workflows: all.map((w) => ({
          name: w.workflow.name,
          description: w.workflow.description,
          enabled: w.workflow.enabled,
          scope: w.scope,
          steps: w.workflow.steps.length,
          triggers: triggerSummary(w.workflow.on),
        })),
      };
    },
  });
}

function getTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_get',
    description: 'Fetch one workflow by name as canonical YAML, plus its on-disk path and scope.',
    inputSchema: z.object({ name: z.string().min(1) }),
    permission: { action: 'allow' },
    handler: async ({ name }) => {
      const entry = await deps.store.get(name);
      if (!entry) throw new MoxxyError({ code: 'TOOL_ERROR', message: `workflow_get: no workflow "${name}".` });
      return { name: entry.workflow.name, scope: entry.scope, path: entry.path, yaml: serializeWorkflow(entry.workflow) };
    },
  });
}

function validateTool(deps: WorkflowToolDeps): ToolDef {
  return defineTool({
    name: 'workflow_validate',
    description:
      'Validate a workflow without running it — checks the schema, the DAG (unique ids, ' +
      'edges, no cycles, one action per step), and `when` syntax. Pass `yaml` to validate ' +
      'a draft, or `name` to validate a saved workflow.',
    inputSchema: z
      .object({
        yaml: z.string().optional(),
        name: z.string().optional(),
      })
      .refine((v) => v.yaml || v.name, { message: 'pass either `yaml` or `name`' }),
    permission: { action: 'allow' },
    handler: async ({ yaml, name }) => {
      if (yaml) {
        const r = parseWorkflowYaml(yaml);
        return { ok: r.ok, errors: r.errors };
      }
      const entry = await deps.store.get(name!);
      if (!entry) return { ok: false, errors: [`no workflow named "${name}"`] };
      return { ok: true, errors: [] };
    },
  });
}

function triggerSummary(on: import('@moxxy/sdk').WorkflowTrigger | undefined): string {
  if (!on) return 'on-demand';
  const parts: string[] = [];
  if (on.schedule?.cron) parts.push(`cron(${on.schedule.cron})`);
  if (on.schedule?.runAt) parts.push('runAt');
  if (on.afterWorkflow) parts.push(`after(${[on.afterWorkflow].flat().join(',')})`);
  if (on.fileChanged) parts.push('fileChanged');
  if (on.webhook) parts.push(`webhook(${on.webhook})`);
  return parts.length > 0 ? parts.join(' + ') : 'on-demand';
}
