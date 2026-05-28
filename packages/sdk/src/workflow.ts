/**
 * Workflows — saved, parameterized, schedulable/event-triggered DAGs whose
 * steps run a skill, a free-form prompt, a tool, or a nested workflow, piping
 * each step's output into the next. A workflow is an *artifact* (authored like
 * a skill, discovered from disk); the strategy that *executes* it is a
 * swappable block — {@link WorkflowExecutorDef} — registered into the
 * `WorkflowExecutorRegistry` and selected by name, mirroring modes/compactors.
 *
 * These are the shared structural types. The zod schema that validates
 * on-disk YAML lives in `@moxxy/plugin-workflows`; its parsed output is
 * assignable to {@link Workflow}.
 */

import type { Skill } from './skill.js';
import type { SubagentSpawner } from './subagent.js';

/** What fires a workflow. Omit `on` entirely for an on-demand-only workflow. */
export interface WorkflowTrigger {
  /** Cron / one-shot time trigger, dispatched by `@moxxy/plugin-scheduler`. */
  readonly schedule?: {
    readonly cron?: string;
    readonly runAt?: number | string;
    readonly timeZone?: string;
  };
  /** Run when the named workflow(s) complete successfully (EventLog-driven). */
  readonly afterWorkflow?: string | ReadonlyArray<string>;
  /** Run when files matching the glob(s) under cwd change (fs.watch-driven). */
  readonly fileChanged?: string | ReadonlyArray<string>;
  /** Named webhook provider whose delivery fires this workflow. */
  readonly webhook?: string;
}

/** How a failed step is handled: abort the workflow, skip past it, or retry. */
export type WorkflowStepErrorMode = 'fail' | 'continue' | 'retry';

/**
 * One node in the DAG. Exactly one *action* key is set
 * (`skill` | `prompt` | `tool` | `workflow`). `input` is the templated prompt
 * for skill/prompt actions; `args` are the templated arguments for
 * tool/workflow actions. `needs` are the upstream step ids this step depends on.
 */
export interface WorkflowStep {
  readonly id: string;
  readonly skill?: string;
  readonly prompt?: string;
  readonly tool?: string;
  readonly workflow?: string;
  readonly input?: string;
  readonly args?: Record<string, unknown>;
  readonly needs: ReadonlyArray<string>;
  /** Condition DSL; when it evaluates false the step is skipped. */
  readonly when?: string;
  readonly onError: WorkflowStepErrorMode;
  readonly retries: number;
  readonly label?: string;
}

export interface WorkflowInputSpec {
  readonly default?: unknown;
  readonly description?: string;
}

export interface WorkflowDelivery {
  /** Soft hint for delivery target — e.g. "telegram", "inbox". */
  readonly channel?: string;
  /** Also drop the final output into `~/.moxxy/inbox/`. Default true. */
  readonly inbox: boolean;
}

export interface Workflow {
  readonly name: string;
  readonly description: string;
  readonly version: number;
  /**
   * When false the workflow is inert: triggers (schedule/event) never fire it
   * and it is excluded from auto-runs, but it stays listable and can still be
   * run explicitly. Toggled from the `/workflows` command.
   */
  readonly enabled: boolean;
  readonly inputs: Record<string, WorkflowInputSpec>;
  readonly on?: WorkflowTrigger;
  readonly delivery?: WorkflowDelivery;
  /** Max steps to run concurrently in one ready-set round. */
  readonly concurrency: number;
  readonly steps: ReadonlyArray<WorkflowStep>;
}

/** Minimal tool surface a step needs — structurally a subset of `ToolRegistry`. */
export interface WorkflowToolRunner {
  get(name: string): unknown | undefined;
  execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

/** Look up sibling artifacts by name during a run. */
export interface WorkflowLookup {
  skill(name: string): Skill | undefined;
  workflow(name: string): Workflow | undefined;
}

/** Lifecycle subtypes an executor emits as `plugin_event`s (mirrors plan_*). */
export type WorkflowEventSubtype =
  | 'workflow_started'
  | 'workflow_step_started'
  | 'workflow_step_completed'
  | 'workflow_step_skipped'
  | 'workflow_step_failed'
  | 'workflow_completed'
  | 'workflow_failed';

/**
 * Everything an executor needs to run a workflow, supplied by the caller.
 * The in-turn `workflow_run` tool wires `spawner` from `ctx.subagents`; the
 * autonomous runner builds one from an isolated session. Kept free of core
 * imports so the executor stays in a plugin.
 */
export interface WorkflowRunDeps {
  readonly spawner: SubagentSpawner;
  readonly tools: WorkflowToolRunner;
  readonly lookup: WorkflowLookup;
  readonly signal: AbortSignal;
  /** Resolved input values (defaults already applied) for this run. */
  readonly inputs?: Record<string, unknown>;
  /** Free-form description of what fired the run (for `{{ trigger }}`). */
  readonly trigger?: string;
  /** Wall-clock source. Injected so tests are deterministic. */
  readonly now?: () => number;
  /** Emit a workflow lifecycle event. No-op when omitted. */
  readonly emit?: (subtype: WorkflowEventSubtype, payload: unknown) => void | Promise<void>;
  readonly logger?: {
    warn?(msg: string, meta?: Record<string, unknown>): void;
    info?(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Nested-workflow recursion depth; executors guard against runaway nesting. */
  readonly depth?: number;
}

export type WorkflowStepStatus = 'completed' | 'skipped' | 'failed';

export interface WorkflowStepResult {
  readonly id: string;
  readonly status: WorkflowStepStatus;
  readonly output: string;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface WorkflowRunResult {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<WorkflowStepResult>;
  /** Output of the terminal (sink) step(s) — what delivery sends. */
  readonly output: string;
  readonly error?: string;
}

/**
 * A swappable workflow-execution strategy. v1 ships one (`dag`); a plugin can
 * register alternatives (parallel-heavy, dry-run, …) and the active one is
 * selected by name via `session.workflowExecutors.setActive(name)`.
 */
export interface WorkflowExecutorDef {
  readonly name: string;
  readonly description?: string;
  run(workflow: Workflow, deps: WorkflowRunDeps): Promise<WorkflowRunResult>;
}
