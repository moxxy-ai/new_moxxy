import { spawn } from 'node:child_process';
import { definePlugin, type Isolator, type Plugin } from '@moxxy/sdk';
import {
  checkAllCaps,
  handleBrokerRequest,
  LOADER_HOOK_SOURCE,
  type BrokerRequest,
} from '@moxxy/plugin-security';

/**
 * Child Node shim inlined as a string. The parent spawns it via
 * `node --input-type=module -e SHIM_SOURCE`, then communicates over
 * stdin/stdout using newline-delimited JSON.
 *
 * Why subprocess vs worker_threads:
 *  - **Separate OS process**: own virtual memory, own file descriptor
 *    table, own signal mask, own credentials. The kernel enforces the
 *    boundary, not V8.
 *  - **Restrictable env**: spawn with a curated `env` so `process.env`
 *    in the child is a strict subset of the parent's.
 *  - **Ulimits**: configurable via the spawn `uid/gid` or wrapping
 *    setrlimit (out of scope for this first cut).
 *  - **Slower startup**: ~80–150ms per call vs ~5–20ms for a worker
 *    thread. Pool/reuse is a future optimization; this iteration
 *    spawns fresh per call so each invocation is fully isolated.
 *
 * Protocol over stdio (one JSON object per line):
 *  - parent → child stdin: { type: 'task', ... } (initial)
 *  - parent → child stdin: { type: 'broker-response', id, ok, ... }
 *  - child → parent stdout: { type: 'broker-request', id, op, args }
 *  - child → parent stdout: { type: 'result', ok, ... } (terminal)
 *
 * Anything else on the child's stdout is ignored as diagnostic noise
 * (the handler module might `console.log` — we don't crash on that).
 * stderr is captured and surfaced if the child exits non-zero.
 */
const SHIM_SOURCE = String.raw`
import { stdin, stdout } from 'node:process';
import { register } from 'node:module';

let buffer = '';
let nextId = 1;
const pending = new Map();
let task = null;

function send(obj) {
  stdout.write(JSON.stringify(obj) + '\n');
}

function rpc(op, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'broker-request', id, op, args });
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

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'task' && !task) {
      task = msg;
      runTask().catch((e) => {
        send({ type: 'result', ok: false, errorName: e && e.name || 'Error', errorMessage: e && e.message || String(e), errorStack: e && e.stack });
      });
    } else if (msg.type === 'broker-response') {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else {
        const e = new Error(msg.errorMessage);
        e.name = msg.errorName || 'Error';
        p.reject(e);
      }
    }
  }
});

async function runTask() {
  const { moduleUrl, exportName, input, syntheticCtx, loaderUrl } = task;
  // Block dangerous imports inside the handler module. Static
  // imports above (node:process, node:module) ran before register()
  // and are not affected.
  register(loaderUrl, import.meta.url);
  const mod = await import(moduleUrl);
  const fn = mod[exportName];
  if (typeof fn !== 'function') {
    send({ type: 'result', ok: false, errorName: 'Error', errorMessage: "subprocess shim: export '" + exportName + "' is " + (typeof fn) });
    return;
  }
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
  try {
    const out = await fn(input, ctx);
    send({ type: 'result', ok: true, value: out });
  } catch (e) {
    send({ type: 'result', ok: false, errorName: e && e.name || 'Error', errorMessage: e && e.message || String(e), errorStack: e && e.stack });
  }
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
type ChildMessage = ResultOk | ResultFail | BrokerRequest;

export interface SubprocessIsolatorOptions {
  /** Default wall-clock budget (ms) when caps.timeMs is omitted. Default 60_000. */
  readonly defaultTimeMs?: number;
  /**
   * Allowlist of env keys the child inherits from the parent process.
   * Default: a minimal POSIX-friendly set (PATH/HOME/USER/SHELL/LANG/LC_ALL/TERM).
   * Override per tool via `caps.env`.
   */
  readonly defaultEnvAllowlist?: ReadonlyArray<string>;
  /**
   * Path to the Node binary to spawn. Default: `process.execPath` so the
   * child runs the same Node version as the parent.
   */
  readonly nodePath?: string;
}

const DEFAULT_ENV: ReadonlyArray<string> = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM'];

/**
 * Subprocess-based Isolator.
 *
 * **What this enforces (in addition to everything `worker` does):**
 * - **OS-level process boundary** — kernel-enforced, not V8-enforced.
 *   Out-of-memory or crashing handler can't affect the parent's heap.
 * - **Restricted env** — the child sees only env keys in `caps.env`
 *   (or the configured allowlist). Other vars are not inherited.
 *
 * **What it does NOT enforce** (parity with worker for now):
 * - Direct `node:fs` / `node:child_process` imports inside the child
 *   bypass the broker. Same advisory limitation as worker.
 * - No ulimit/cgroup/namespace setup. The child is just a regular
 *   Node process; if you need stronger sandboxing, use `docker`
 *   (Phase 3+, not yet implemented) or wrap the spawned binary in
 *   the OS-level sandbox of your choice.
 */
export function createSubprocessIsolator(opts: SubprocessIsolatorOptions = {}): Isolator {
  const defaultTimeMs = opts.defaultTimeMs ?? 60_000;
  const envAllowlist = opts.defaultEnvAllowlist ?? DEFAULT_ENV;
  const nodePath = opts.nodePath ?? process.execPath;

  return {
    name: 'subprocess',
    strength: 'subprocess',
    async run(call, _handler, caps, signal) {
      if (!call.moduleRef) {
        throw new Error(
          `[security:subprocess] tool '${call.toolName}' has no handlerModule declared; ` +
            `subprocess isolation requires the tool to be re-importable.`,
        );
      }

      const verdict = checkAllCaps(call.input, caps, call.cwd);
      if (!verdict.ok) {
        throw new Error(`[security:subprocess] ${verdict.reason}`);
      }

      const timeMs = caps.timeMs ?? defaultTimeMs;
      const allowedEnv = caps.env ?? envAllowlist;
      const env: Record<string, string> = {};
      for (const key of allowedEnv) {
        const v = process.env[key];
        if (v !== undefined) env[key] = v;
      }

      const child = spawn(nodePath, ['--input-type=module', '-e', SHIM_SOURCE], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return new Promise<unknown>((resolve, reject) => {
        let stderr = '';
        let stdoutBuffer = '';
        let settled = false;
        const cleanup = new Set<() => void>();
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup.forEach((fn) => fn());
          cleanup.clear();
          action();
          if (!child.killed) child.kill('SIGTERM');
        };

        if (signal.aborted) {
          finish(() =>
            reject(new Error(`[security:subprocess] tool '${call.toolName}' aborted`)),
          );
          return;
        }

        const timer = setTimeout(() => {
          finish(() =>
            reject(
              new Error(
                `[security:subprocess] tool '${call.toolName}' exceeded ${timeMs}ms budget`,
              ),
            ),
          );
        }, timeMs);
        cleanup.add(() => clearTimeout(timer));

        const onAbort = (): void => {
          finish(() =>
            reject(new Error(`[security:subprocess] tool '${call.toolName}' aborted`)),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup.add(() => signal.removeEventListener('abort', onAbort));

        // Send the initial task.
        const task = {
          type: 'task',
          moduleUrl: call.moduleRef!.url,
          exportName: call.moduleRef!.export,
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
        try {
          child.stdin.write(JSON.stringify(task) + '\n');
        } catch (e) {
          finish(() => reject(e instanceof Error ? e : new Error(String(e))));
          return;
        }

        const handleMessage = (msg: ChildMessage): void => {
          if (settled) return;
          if (msg.type === 'broker-request') {
            void handleBrokerRequest(msg, {
              caps,
              cwd: call.cwd,
              signal,
            }).then((response) => {
              if (!settled) {
                try {
                  child.stdin.write(JSON.stringify(response) + '\n');
                } catch {
                  // Child closed stdin; ignore — likely about to exit.
                }
              }
            });
            return;
          }
          if (msg.ok) {
            finish(() => resolve(msg.value));
          } else {
            const e = new Error(msg.errorMessage);
            e.name = msg.errorName;
            if (msg.errorStack) e.stack = msg.errorStack;
            finish(() => reject(e));
          }
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdoutBuffer += chunk;
          let nl: number;
          while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
            const line = stdoutBuffer.slice(0, nl);
            stdoutBuffer = stdoutBuffer.slice(nl + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line) as ChildMessage;
              handleMessage(msg);
            } catch {
              // Not a protocol line — ignore. The shim doesn't emit
              // arbitrary stdout, but handler-imported modules might.
            }
          }
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        child.once('error', (e) => {
          finish(() => reject(e instanceof Error ? e : new Error(String(e))));
        });

        child.once('exit', (code) => {
          if (!settled) {
            const msg = stderr.trim() || `subprocess exited with code ${code}`;
            finish(() =>
              reject(new Error(`[security:subprocess] '${call.toolName}': ${msg}`)),
            );
          }
        });
      });
    },
  };
}

/** Default singleton. Use `createSubprocessIsolator({...})` to tune. */
export const subprocessIsolator: Isolator = createSubprocessIsolator();

/**
 * Auto-discovery entry: a user-installed copy registers the isolator via
 * `PluginSpec.isolators`. Inert until opted into with `security.isolator: 'subprocess'`.
 */
const plugin: Plugin = definePlugin({
  name: '@moxxy/isolator-subprocess',
  isolators: [subprocessIsolator],
});
export default plugin;
