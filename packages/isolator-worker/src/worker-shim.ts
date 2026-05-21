/**
 * Worker entry shim. Runs inside a worker_threads Worker.
 *
 * The parent thread `postMessage`s a `WorkerTask` describing which
 * module to import, which export to call, the input, and a synthetic
 * ToolContext stand-in. The shim dynamic-imports the module, calls
 * the named export with `(input, ctx)`, and posts the result (or
 * error) back via `parentPort`.
 *
 * The actual work lives in `runTask` (pure async fn) so unit tests can
 * exercise the shim logic without spinning up a real Worker.
 *
 * What the shim does NOT provide to the handler:
 * - A live `EventLogReader` — only a frozen empty log.
 * - A `SubagentSpawner` — `ctx.subagents` is undefined in-worker.
 * - A live AbortSignal linked to the parent — the parent terminates
 *   the whole worker on abort/timeout, which is the right semantic
 *   for an isolated boundary.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export interface WorkerTask {
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly input: unknown;
  readonly syntheticCtx: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly callId: string;
    readonly cwd: string;
  };
}

export interface WorkerOk {
  readonly ok: true;
  readonly value: unknown;
}

export interface WorkerFail {
  readonly ok: false;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorStack?: string;
}

export type WorkerMessage = WorkerOk | WorkerFail;

/**
 * Pure execution of a worker task. Exported so unit tests can
 * exercise the shim logic without spawning a real worker.
 */
export async function runTask(task: WorkerTask): Promise<WorkerMessage> {
  try {
    const mod = await import(importSpecifierFor(task.moduleUrl));
    const fn = (mod as Record<string, unknown>)[task.exportName];
    if (typeof fn !== 'function') {
      return {
        ok: false,
        errorName: 'Error',
        errorMessage:
          `worker shim: export '${task.exportName}' from ${task.moduleUrl} is ` +
          `${typeof fn}, expected function`,
      };
    }

    const syntheticAbort = new AbortController();
    const ctx = {
      sessionId: task.syntheticCtx.sessionId,
      turnId: task.syntheticCtx.turnId,
      callId: task.syntheticCtx.callId,
      cwd: task.syntheticCtx.cwd,
      signal: syntheticAbort.signal,
      log: emptyLog(),
      logger: noopLogger(),
    };

    const out = await (fn as (input: unknown, ctx: unknown) => unknown)(task.input, ctx);
    return { ok: true, value: out };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      errorName: e.name ?? 'Error',
      errorMessage: e.message ?? String(err),
      ...(e.stack ? { errorStack: e.stack } : {}),
    };
  }
}

function importSpecifierFor(moduleUrl: string): string {
  return moduleUrl.startsWith('file:') ? fileURLToPath(moduleUrl) : moduleUrl;
}

function emptyLog(): {
  length: number;
  at: () => undefined;
  slice: () => never[];
  ofType: () => never[];
  byTurn: () => never[];
  toJSON: () => never[];
} {
  return {
    length: 0,
    at: () => undefined,
    slice: () => [],
    ofType: () => [],
    byTurn: () => [],
    toJSON: () => [],
  };
}

function noopLogger(): {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
} {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

// Worker entry: when this module is loaded as a Worker target,
// `workerData` is populated and we should drive the task. When
// imported from regular code (e.g. unit tests doing
// `import { runTask } from './worker-shim.js'`), workerData is null
// — skip the auto-run.
if (parentPort && workerData) {
  const task = workerData as WorkerTask;
  const result = await runTask(task);
  parentPort.postMessage(result);
}
