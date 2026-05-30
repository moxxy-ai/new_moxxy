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

/** Response format for logic steps (`bridge` only may use `plain`). */
export type WorkflowLogicStepFormat = 'json' | 'plain';

/**
 * One node in the DAG. Exactly one *action* key is set
 * (`skill` | `prompt` | `tool` | `workflow` | `bridge` | `condition` | `switch`).
 * Logic steps run a single no-tools subagent turn; default response is JSON
 * (`vars`, `branch`, optional `text`). `input` is the templated prompt for
 * skill/prompt; `args` for tool/workflow; `bridge` / `condition` / `switch` hold
 * the logic instruction text.
 */
export interface WorkflowStep {
  readonly id: string;
  readonly skill?: string;
  readonly prompt?: string;
  readonly tool?: string;
  readonly workflow?: string;
  /** Extract/transform upstream data into `vars` (and optional `text`). */
  readonly bridge?: string;
  /** If/else gate: agent returns `{"branch":"then"|"else"}`. */
  readonly condition?: string;
  readonly then?: ReadonlyArray<string>;
  readonly else?: ReadonlyArray<string>;
  /** Multi-way gate: agent returns `{"branch":"<caseId>"}`. */
  readonly switch?: string;
  readonly cases?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly default?: ReadonlyArray<string>;
  readonly input?: string;
  readonly args?: Record<string, unknown>;
  readonly needs: ReadonlyArray<string>;
  /** Legacy deterministic guard DSL; prefer `condition`/`switch` for semantics. */
  readonly when?: string;
  readonly onError: WorkflowStepErrorMode;
  readonly retries: number;
  readonly label?: string;
  /** `plain` only on `bridge`; `condition`/`switch` always require JSON. */
  readonly format?: WorkflowLogicStepFormat;
  /**
   * When true on a `prompt` or `skill` step, the DAG pauses after the
   * subagent's first turn so the operator can reply once; the step completes
   * after a follow-up turn. Ignored on logic / `tool` / `workflow` steps.
   */
  readonly awaitInput?: boolean;
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

/** Visual editor metadata. Runtime executors must ignore this field. */
export interface WorkflowUiLayoutNode {
  readonly x: number;
  readonly y: number;
}

export interface WorkflowUiViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface WorkflowUiLayout {
  readonly nodes: Record<string, WorkflowUiLayoutNode>;
  readonly viewport?: WorkflowUiViewport;
}

export interface WorkflowUi {
  readonly layout?: WorkflowUiLayout;
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
  /** GUI-only metadata persisted with the YAML artifact. */
  readonly ui?: WorkflowUi;
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
  | 'workflow_step_awaiting_input'
  | 'workflow_paused'
  | 'workflow_resumed'
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

export type WorkflowStepStatus = 'completed' | 'skipped' | 'failed' | 'awaiting_input';

export type WorkflowRunStatus = 'completed' | 'paused' | 'failed';

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
  readonly status: WorkflowRunStatus;
  readonly steps: ReadonlyArray<WorkflowStepResult>;
  /** Output of the terminal (sink) step(s) — what delivery sends. */
  readonly output: string;
  readonly error?: string;
  /** Set when `status` is `paused` — use with workflow reply API. */
  readonly runId?: string;
  readonly pendingStepId?: string;
  /** Child subagent session id for chat / permissions while paused. */
  readonly interactionAgentId?: string;
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
