import {
  defineWorkflowExecutor,
  type SubagentSpec,
  type Workflow,
  type WorkflowExecutorDef,
  type WorkflowRunDeps,
  type WorkflowRunResult,
  type WorkflowStep,
  type WorkflowStepResult,
  type WorkflowStepStatus,
} from '@moxxy/sdk';
import { evalCondition, renderArgs, renderTemplate, type TemplateScope } from '../template.js';

export const DAG_EXECUTOR_NAME = 'dag';
const MAX_NESTING_DEPTH = 5;

/**
 * Default workflow executor: a parallel DAG runner.
 *
 * Steps with all dependencies settled run in waves of up to
 * `workflow.concurrency`. A step whose `when` evaluates false is skipped (its
 * dependents treat it as settled with empty output). On step failure the
 * `onError` disposition decides whether to abort the workflow or continue past
 * it (after `retries` extra attempts). Lifecycle is emitted as `plugin_event`s
 * via `deps.emit`, mirroring plan-execute's `plan_step_*`.
 *
 * The executor is pure with respect to the filesystem — it returns the full
 * per-step result set; persisting a run record is the engine/runner's job.
 */

type StepRuntimeStatus = 'pending' | WorkflowStepStatus;

interface StepState {
  status: StepRuntimeStatus;
  output: string;
  error?: string;
  startedAt: number;
  endedAt: number;
}

function nowFn(deps: WorkflowRunDeps): () => number {
  return deps.now ?? (() => Date.now());
}

function resolveInputs(workflow: Workflow, deps: WorkflowRunDeps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(workflow.inputs)) {
    if (spec.default !== undefined) out[name] = spec.default;
  }
  for (const [name, value] of Object.entries(deps.inputs ?? {})) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function buildScope(
  states: Map<string, StepState>,
  inputs: Record<string, unknown>,
  deps: WorkflowRunDeps,
  nowIso: string,
): TemplateScope {
  const steps: Record<string, { output: string }> = {};
  for (const [id, st] of states) steps[id] = { output: st.output };
  return {
    steps,
    inputs,
    ...(deps.trigger != null ? { trigger: deps.trigger } : {}),
    now: nowIso,
  };
}

async function runExecutor(workflow: Workflow, deps: WorkflowRunDeps): Promise<WorkflowRunResult> {
  const now = nowFn(deps);
  const inputs = resolveInputs(workflow, deps);
  const states = new Map<string, StepState>();
  for (const step of workflow.steps) {
    states.set(step.id, { status: 'pending', output: '', startedAt: 0, endedAt: 0 });
  }

  await deps.emit?.('workflow_started', { name: workflow.name, steps: workflow.steps.length });

  const settled = (id: string): boolean => {
    const s = states.get(id)?.status;
    return s === 'completed' || s === 'skipped' || s === 'failed';
  };

  let aborted = false;
  let abortReason: string | undefined;

  while (!aborted) {
    if (deps.signal.aborted) {
      abortReason = 'aborted';
      break;
    }

    // 1. Resolve any newly-ready steps whose `when` is false → skip them.
    //    Loop so a skip that unblocks another skip settles in one pass.
    let skippedSomething = true;
    while (skippedSomething) {
      skippedSomething = false;
      for (const step of workflow.steps) {
        const st = states.get(step.id)!;
        if (st.status !== 'pending') continue;
        if (!step.needs.every(settled)) continue;
        if (step.when == null) continue;
        const scope = buildScope(states, inputs, deps, new Date(now()).toISOString());
        let keep: boolean;
        try {
          keep = evalCondition(step.when, scope);
        } catch (err) {
          // A malformed condition that slipped past validation fails the step.
          st.status = 'failed';
          st.error = `when: ${err instanceof Error ? err.message : String(err)}`;
          st.startedAt = st.endedAt = now();
          await deps.emit?.('workflow_step_failed', { id: step.id, error: st.error });
          if (step.onError !== 'continue') {
            aborted = true;
            abortReason = st.error;
          }
          skippedSomething = true;
          continue;
        }
        if (!keep) {
          st.status = 'skipped';
          st.startedAt = st.endedAt = now();
          await deps.emit?.('workflow_step_skipped', { id: step.id });
          skippedSomething = true;
        }
      }
      if (aborted) break;
    }
    if (aborted) break;

    // 2. Gather ready executable steps (deps settled, when true / absent).
    const ready = workflow.steps.filter((step) => {
      const st = states.get(step.id)!;
      return st.status === 'pending' && step.needs.every(settled);
    });

    if (ready.length === 0) {
      const anyPending = [...states.values()].some((s) => s.status === 'pending');
      if (anyPending) {
        abortReason = 'workflow stalled — no runnable steps (check needs/when)';
        aborted = true;
      }
      break;
    }

    // 3. Run a wave (cap at concurrency). Independent steps run together.
    const wave = ready.slice(0, Math.max(1, workflow.concurrency));
    const scope = buildScope(states, inputs, deps, new Date(now()).toISOString());
    await Promise.all(
      wave.map(async (step) => {
        const st = states.get(step.id)!;
        st.startedAt = now();
        await deps.emit?.('workflow_step_started', {
          id: step.id,
          label: step.label ?? step.id,
        });
        const outcome = await runStep(step, scope, deps);
        st.endedAt = now();
        if (outcome.ok) {
          st.status = 'completed';
          st.output = outcome.output;
          await deps.emit?.('workflow_step_completed', {
            id: step.id,
            preview: outcome.output.slice(0, 280),
          });
        } else {
          st.status = 'failed';
          st.error = outcome.error;
          await deps.emit?.('workflow_step_failed', { id: step.id, error: outcome.error });
          if (step.onError !== 'continue') {
            aborted = true;
            abortReason = `step "${step.id}" failed: ${outcome.error}`;
          }
        }
      }),
    );
  }

  const stepResults: WorkflowStepResult[] = workflow.steps.map((step) => {
    const st = states.get(step.id)!;
    return {
      id: step.id,
      status: st.status === 'pending' ? 'skipped' : st.status,
      output: st.output,
      ...(st.error ? { error: st.error } : {}),
      startedAt: st.startedAt,
      endedAt: st.endedAt,
    };
  });

  // A run is "ok" when it reached the end without a hard abort. A failure on
  // a step whose `onError` is `continue` is tolerated by the author, so it
  // does not flip the run to failed — the per-step status still records it.
  const ok = !aborted;
  const output = sinkOutput(workflow, states);

  if (ok) {
    await deps.emit?.('workflow_completed', { name: workflow.name, output: output.slice(0, 280) });
  } else {
    await deps.emit?.('workflow_failed', { name: workflow.name, error: abortReason });
  }

  return {
    ok,
    steps: stepResults,
    output,
    ...(ok ? {} : { error: abortReason ?? 'workflow failed' }),
  };
}

/** Concatenate the outputs of completed terminal (sink) steps. */
function sinkOutput(workflow: Workflow, states: Map<string, StepState>): string {
  const needed = new Set<string>();
  for (const step of workflow.steps) for (const dep of step.needs) needed.add(dep);
  const sinks = workflow.steps.filter((s) => !needed.has(s.id));
  const completed = sinks
    .map((s) => states.get(s.id))
    .filter((st): st is StepState => st?.status === 'completed' && st.output.length > 0);
  if (completed.length > 0) return completed.map((s) => s.output).join('\n\n');
  // Fall back to the last completed step's output.
  const lastCompleted = [...states.values()].filter((s) => s.status === 'completed').pop();
  return lastCompleted?.output ?? '';
}

interface StepOutcome {
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
}

async function runStep(
  step: WorkflowStep,
  scope: TemplateScope,
  deps: WorkflowRunDeps,
): Promise<StepOutcome> {
  const attempts = 1 + Math.max(0, step.retries);
  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (deps.signal.aborted) return { ok: false, output: '', error: 'aborted' };
    try {
      const output = await runStepOnce(step, scope, deps);
      return { ok: true, output };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      deps.logger?.warn?.('workflow step attempt failed', {
        step: step.id,
        attempt: attempt + 1,
        error: lastError,
      });
    }
  }
  return { ok: false, output: '', error: lastError };
}

async function runStepOnce(
  step: WorkflowStep,
  scope: TemplateScope,
  deps: WorkflowRunDeps,
): Promise<string> {
  const opts = deps.logger ? { logger: deps.logger } : {};

  if (step.tool) {
    const args = renderArgs(step.args ?? {}, scope, opts);
    const result = await deps.tools.execute(step.tool, args, deps.signal);
    return typeof result === 'string' ? result : JSON.stringify(result ?? '');
  }

  if (step.workflow) {
    const nested = deps.lookup.workflow(step.workflow);
    if (!nested) throw new Error(`nested workflow "${step.workflow}" not found`);
    const depth = (deps.depth ?? 0) + 1;
    if (depth > MAX_NESTING_DEPTH) {
      throw new Error(`nested workflow depth exceeded ${MAX_NESTING_DEPTH}`);
    }
    const nestedInputs = renderArgs(step.args ?? {}, scope, opts) as Record<string, unknown>;
    const result = await runExecutor(nested, {
      ...deps,
      inputs: nestedInputs,
      depth,
      trigger: `workflow:${step.workflow}`,
    });
    if (!result.ok) throw new Error(result.error ?? `nested workflow "${step.workflow}" failed`);
    return result.output;
  }

  // skill / prompt → run a child agent and capture its final text.
  const spec = buildSubagentSpec(step, scope, deps, opts);
  const child = await deps.spawner.spawn(spec);
  if (child.error) throw new Error(child.error.message);
  return child.text;
}

function buildSubagentSpec(
  step: WorkflowStep,
  scope: TemplateScope,
  deps: WorkflowRunDeps,
  opts: { logger?: { warn?(msg: string, meta?: Record<string, unknown>): void } },
): SubagentSpec {
  const label = step.label ?? step.id;
  const renderedInput = step.input ? renderTemplate(step.input, scope, opts) : '';

  if (step.skill) {
    const skill = deps.lookup.skill(step.skill);
    if (!skill) throw new Error(`skill "${step.skill}" not found`);
    const allowed = skill.frontmatter['allowed-tools'];
    const prompt =
      renderedInput ||
      `Follow the "${skill.frontmatter.name}" playbook in your system prompt.`;
    const spec: SubagentSpec = {
      prompt,
      systemPrompt: skill.body,
      label,
    };
    if (allowed && allowed.length > 0) (spec as { allowedTools?: ReadonlyArray<string> }).allowedTools = allowed;
    return spec;
  }

  // prompt step
  return { prompt: renderTemplate(step.prompt ?? '', scope, opts), label };
}

export const dagExecutor: WorkflowExecutorDef = defineWorkflowExecutor({
  name: DAG_EXECUTOR_NAME,
  description: 'Parallel DAG runner: steps with settled dependencies run in waves up to `concurrency`.',
  run: runExecutor,
});
