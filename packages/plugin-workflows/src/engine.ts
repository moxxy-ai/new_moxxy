import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { moxxyPath, type Workflow, type WorkflowExecutorDef, type WorkflowRunDeps, type WorkflowRunResult } from '@moxxy/sdk';
import { ulid } from 'ulid';
import { dagExecutor } from './executor/dag.js';

/**
 * Runs a workflow through the active executor and appends a JSONL run record
 * to `~/.moxxy/workflow-runs/` for `/workflows inspect`. The executor itself
 * is fs-free; record-keeping lives here so the executor stays unit-testable.
 */

export function defaultRunRecordDir(): string {
  return moxxyPath('workflow-runs');
}

export interface RunWorkflowOptions {
  /** Active executor; falls back to the built-in `dag`. */
  readonly executor?: WorkflowExecutorDef | null;
  /** Override the run-record directory (tests). Pass null to skip recording. */
  readonly recordDir?: string | null;
}

export async function runWorkflow(
  workflow: Workflow,
  deps: WorkflowRunDeps,
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const executor = opts.executor ?? dagExecutor;
  const startedAt = (deps.now ?? Date.now)();
  const result = await executor.run(workflow, deps);
  if (opts.recordDir !== null) {
    await writeRunRecord(workflow, result, startedAt, executor.name, deps, opts.recordDir ?? defaultRunRecordDir()).catch(
      (err) =>
        deps.logger?.warn?.('workflow: failed to write run record', {
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  }
  return result;
}

async function writeRunRecord(
  workflow: Workflow,
  result: WorkflowRunResult,
  startedAt: number,
  executorName: string,
  deps: WorkflowRunDeps,
  dir: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${workflow.name}-${ulid().slice(-6)}.jsonl`);
  const lines = [
    JSON.stringify({
      kind: 'run',
      workflow: workflow.name,
      executor: executorName,
      startedAt,
      trigger: deps.trigger ?? 'manual',
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    }),
    ...result.steps.map((s) => JSON.stringify({ kind: 'step', ...s })),
    JSON.stringify({ kind: 'output', output: result.output }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
}
