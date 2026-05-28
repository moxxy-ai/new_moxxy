import { Worker } from 'node:worker_threads';
import { definePlugin, type Isolator, type Plugin } from '@moxxy/sdk';
import {
  checkAllCaps,
  handleBrokerRequest,
  LOADER_HOOK_SOURCE,
  type BrokerRequest,
} from '@moxxy/plugin-security';

/**
 * Worker entry code, inlined as a string and run via
 * `new Worker(SHIM_SOURCE, { eval: true, workerData })`.
 *
 * The shim:
 *  1. Imports the tool's handler module and named export.
 *  2. Builds a synthetic `ToolContext` with capability-mediated
 *     `fs` + `fetch` proxies. Each call posts a `broker-request` to
 *     the parent, awaits a `broker-response` with a matching id, and
 *     resolves the in-worker Promise.
 *  3. Calls the handler with (input, ctx).
 *  4. Posts a `result` message to the parent with success or failure.
 *
 * RPC message shapes (see `broker.ts`):
 *  - worker → parent: { type: 'broker-request', id, op, args }
 *  - parent → worker: { type: 'broker-response', id, ok, value/error... }
 *  - worker → parent (terminal): { type: 'result', ok, value/error... }
 *
 * Inlined as a string for the reasons documented in Phase 2 first cut:
 * worker_threads file form requires the .js to physically exist at a
 * known URL, which is asymmetric across published / src-mode runs.
 */
const SHIM_SOURCE = `
const { parentPort, workerData } = await import('node:worker_threads');
const { moduleUrl, exportName, input, syntheticCtx, loaderUrl } = workerData;
// Register the import-blocking loader BEFORE the handler module
// loads. Subsequent imports (including the handler's transitive
// imports) go through this hook; node:fs / node:child_process / raw
// net throw at resolution time. The shim's own static needs
// (node:worker_threads, node:module) ran before this line, so they
// aren't affected.
const { register } = await import('node:module');
register(loaderUrl, import.meta.url);

// RPC client state
let nextId = 1;
const pending = new Map();

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'broker-response') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.value);
    } else {
      const e = new Error(msg.errorMessage);
      e.name = msg.errorName || 'Error';
      p.reject(e);
    }
  }
});

function rpc(op, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'broker-request', id, op, args });
  });
}

const broker = {
  fs: {
    readFile: (filePath, opts) => rpc('fs.readFile', [filePath, opts || {}]),
    writeFile: (filePath, data) => rpc('fs.writeFile', [filePath, data]),
    readdir: (dirPath) => rpc('fs.readdir', [dirPath]),
    stat: (filePath) => rpc('fs.stat', [filePath]),
  },
  fetch: (url, init) => rpc('fetch', [url, init || {}]),
  exec: (cmd, args, opts) => rpc('exec', [cmd, args || [], opts || {}]),
};

try {
  const mod = await import(moduleUrl);
  const fn = mod[exportName];
  if (typeof fn !== 'function') {
    parentPort.postMessage({
      type: 'result',
      ok: false,
      errorName: 'Error',
      errorMessage: "worker shim: export '" + exportName + "' from " + moduleUrl + " is " + (typeof fn) + ", expected function",
    });
  } else {
    const ctx = {
      sessionId: syntheticCtx.sessionId,
      turnId: syntheticCtx.turnId,
      callId: syntheticCtx.callId,
      cwd: syntheticCtx.cwd,
      signal: new AbortController().signal,
      log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      fs: broker.fs,
      fetch: broker.fetch,
      exec: broker.exec,
    };
    const out = await fn(input, ctx);
    parentPort.postMessage({ type: 'result', ok: true, value: out });
  }
} catch (e) {
  parentPort.postMessage({
    type: 'result',
    ok: false,
    errorName: e && e.name ? e.name : 'Error',
    errorMessage: e && e.message ? e.message : String(e),
    errorStack: e && e.stack ? e.stack : undefined,
  });
}
`;

interface ResultOk {
  readonly type: 'result';
  readonly ok: true;
  readonly value: unknown;
}
interface ResultFail {
  readonly type: 'result';
  readonly ok: false;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorStack?: string;
}
type WorkerMessage = ResultOk | ResultFail | BrokerRequest;

export interface WorkerIsolatorOptions {
  /** Default heap ceiling (MB) when caps.memMb is omitted. Default 256. */
  readonly defaultMemMb?: number;
  /** Default wall-clock budget (ms) when caps.timeMs is omitted. Default 60_000. */
  readonly defaultTimeMs?: number;
}

/**
 * worker_threads-based Isolator with a capability broker.
 *
 * **What this enforces:**
 * - **Memory** — `resourceLimits.maxOldGenerationSizeMb` from `caps.memMb`.
 *   V8 kills the worker if it exceeds the heap budget.
 * - **Wall-clock** — `caps.timeMs` via `setTimeout` → `worker.terminate()`.
 * - **Abort** — parent's `signal` → `worker.terminate()`.
 * - **JS state isolation** — worker has its own module cache, globals,
 *   V8 heap. No closures from the main thread are visible.
 * - **Cap declarations on input** — `checkAllCaps` validates input
 *   fields against `fs` / `net` declarations before launching.
 * - **Mediated fs.readFile** — handlers that use `ctx.fs.readFile()` get
 *   every call re-checked against `caps.fs.read` on the parent side
 *   before the syscall happens.
 * - **Mediated fetch** — handlers that use `ctx.fetch()` get every URL
 *   re-checked against `caps.net` on the parent side before the
 *   socket is opened.
 *
 * **What this still does NOT enforce** (Phase 2.2+):
 * - **Direct `node:fs`** — a handler can `import('node:fs').then(fs => fs.readFileSync('/etc/passwd'))`
 *   and bypass the broker. The broker is advisory; tools opt in by
 *   using `ctx.fs` instead of `node:fs`. A future loader-hook layer
 *   could block direct imports, but that's complex and Node doesn't
 *   yet have a stable API for it.
 * - **Other fs ops** — only `readFile` is brokered. `writeFile`,
 *   `readdir`, `stat`, etc. will land in Phase 2.2.
 * - **`child_process` / raw `net`** — not brokered. Tools that need
 *   subprocess access should declare `caps.subprocess: true` and
 *   accept that the worker can spawn anything; a future broker can
 *   add `child_process.spawn` with command-allowlist enforcement.
 * - **Env** — the worker inherits `process.env`.
 *
 * **Documenting the gap honestly** is more important than pretending
 * to close it. The threat model is "well-behaved handler that opts
 * into the broker," not "adversarial handler trying to escape."
 */
export function createWorkerIsolator(opts: WorkerIsolatorOptions = {}): Isolator {
  const defaultMemMb = opts.defaultMemMb ?? 256;
  const defaultTimeMs = opts.defaultTimeMs ?? 60_000;

  return {
    name: 'worker',
    strength: 'worker',
    async run(call, _handler, caps, signal) {
      if (!call.moduleRef) {
        throw new Error(
          `[security:worker] tool '${call.toolName}' has no handlerModule declared; ` +
            `worker isolation requires the tool to be re-importable. Either declare ` +
            `\`isolation.handlerModule\` on the tool, or configure a weaker isolator.`,
        );
      }

      const verdict = checkAllCaps(call.input, caps, call.cwd);
      if (!verdict.ok) {
        throw new Error(`[security:worker] ${verdict.reason}`);
      }

      const timeMs = caps.timeMs ?? defaultTimeMs;
      const memMb = caps.memMb ?? defaultMemMb;

      const workerData = {
        moduleUrl: call.moduleRef.url,
        exportName: call.moduleRef.export,
        input: call.input,
        syntheticCtx: {
          sessionId: call.sessionId,
          turnId: call.turnId,
          callId: call.callId,
          cwd: call.cwd,
        },
        loaderUrl:
          'data:text/javascript,' + encodeURIComponent(LOADER_HOOK_SOURCE),
      };

      const worker = new Worker(SHIM_SOURCE, {
        eval: true,
        workerData,
        resourceLimits: {
          maxOldGenerationSizeMb: memMb,
          maxYoungGenerationSizeMb: Math.max(16, Math.floor(memMb / 4)),
        },
      });

      return new Promise<unknown>((resolve, reject) => {
        const cleanup = new Set<() => void>();
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup.forEach((fn) => fn());
          cleanup.clear();
          action();
          void worker.terminate();
        };

        if (signal.aborted) {
          finish(() =>
            reject(new Error(`[security:worker] tool '${call.toolName}' aborted`)),
          );
          return;
        }

        const timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `[security:worker] tool '${call.toolName}' exceeded ${timeMs}ms budget`,
              ),
            ),
          );
        }, timeMs);
        cleanup.add(() => clearTimeout(timer));

        const onAbort = (): void => {
          finish(() =>
            reject(new Error(`[security:worker] tool '${call.toolName}' aborted`)),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup.add(() => signal.removeEventListener('abort', onAbort));

        worker.on('message', (msg: WorkerMessage) => {
          if (settled) return;
          if (msg.type === 'broker-request') {
            void handleBrokerRequest(msg, {
              caps,
              cwd: call.cwd,
              signal,
            }).then((response) => {
              if (!settled) worker.postMessage(response);
            });
            return;
          }
          // type === 'result' — the terminal message
          if (msg.ok) {
            finish(() => resolve(msg.value));
          } else {
            const e = new Error(msg.errorMessage);
            e.name = msg.errorName;
            if (msg.errorStack) e.stack = msg.errorStack;
            finish(() => reject(e));
          }
        });

        worker.once('error', (e) => {
          finish(() => reject(e instanceof Error ? e : new Error(String(e))));
        });

        worker.once('exit', (code) => {
          if (!settled && code !== 0) {
            finish(() =>
              reject(
                new Error(
                  `[security:worker] worker for '${call.toolName}' exited with code ${code}`,
                ),
              ),
            );
          }
        });
      });
    },
  };
}

/** Default singleton. Use `createWorkerIsolator({...})` to tune limits. */
export const workerIsolator: Isolator = createWorkerIsolator();

/**
 * Auto-discovery entry: a user-installed copy registers the isolator via
 * `PluginSpec.isolators`. Inert until opted into with `security.isolator: 'worker'`.
 */
const plugin: Plugin = definePlugin({
  name: '@moxxy/isolator-worker',
  isolators: [workerIsolator],
});
export default plugin;

// Re-export broker types from plugin-security for convenience.
export {
  handleBrokerRequest,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerOp,
} from '@moxxy/plugin-security';
