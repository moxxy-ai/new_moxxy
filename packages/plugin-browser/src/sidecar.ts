#!/usr/bin/env node
/**
 * Playwright sidecar — owns a single browser context. Speaks newline-delimited
 * JSON-RPC over stdio so the parent (`browser_session` tool) doesn't load
 * Playwright into its own process. Crash isolation, lazy install: the parent
 * only spawns this when the heavy tier is actually needed.
 *
 * Wire format (one line per message):
 *   { "id": "uuid", "method": "goto"|"click"|"fill"|"text"|"html"|"screenshot"|"eval"|"close", "params": {...} }
 *   { "id": "uuid", "ok": true,  "result": ... }
 *   { "id": "uuid", "ok": false, "error": { "message": "...", "kind": "init"|"navigation"|"runtime"|"timeout" } }
 *
 * Run with `node dist/sidecar.js` (the package's `bin` entry is
 * `moxxy-browser-sidecar`). Parent terminates by closing stdin or sending
 * `{method:'close'}`.
 */

import * as readline from 'node:readline';
import { dispatch, teardown, type SidecarState } from './sidecar/dispatch.js';
import { errMsg, type Reply, type Req } from './sidecar/types.js';

const state: SidecarState = { handle: null, pendingInstallNotice: null };

function write(reply: Reply): void {
  // Drain the install-notice flag into the first reply that goes out
  // after the install completed, then clear it. Errors get the notice
  // too — sometimes the launch retry surfaces a different problem and
  // the user still wants to know we tried to install.
  if (state.pendingInstallNotice) {
    if (reply.ok) {
      reply = { ...reply, notice: state.pendingInstallNotice };
    } else {
      reply = {
        ...reply,
        error: {
          ...reply.error,
          message: `${state.pendingInstallNotice} Then: ${reply.error.message}`,
        },
      };
    }
    state.pendingInstallNotice = null;
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
}

/**
 * Tears down the browser context AND exits the process. Used both by
 * the explicit `close` RPC path and the parent-loss / stdin-close
 * paths so all cleanup goes through one routine.
 */
async function shutdownAndExit(code: number): Promise<void> {
  await teardown(state);
  process.exit(code);
}

/**
 * Parent watchdog: if the moxxy process that spawned this sidecar
 * disappears (crash, SIGKILL, terminal hangup), there's no stdin EOF
 * to rely on — orphan Chromium would keep running and chew CPU/memory
 * until the user notices. Poll the parent PID every few seconds and
 * self-terminate when it goes away.
 *
 * `process.kill(pid, 0)` is the POSIX trick for "does this PID
 * exist?" — no signal is actually delivered. Throws ESRCH when the
 * process is gone (or EPERM when it exists but we can't signal it —
 * still alive, so don't treat as gone).
 */
function startParentWatchdog(): void {
  const parentPid = process.ppid;
  if (!parentPid || parentPid <= 1) return; // already orphaned (init), nothing to watch
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        clearInterval(interval);
        void shutdownAndExit(0);
      }
      // EPERM means the process exists but we can't signal it — still alive.
    }
  }, 2000);
  interval.unref?.(); // never block the event loop from exiting
}

let queue: Promise<void> = Promise.resolve();

async function main(): Promise<void> {
  startParentWatchdog();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: Req;
    try {
      req = JSON.parse(line) as Req;
    } catch {
      write({ id: 'unknown', ok: false, error: { message: 'invalid JSON', kind: 'runtime' } });
      return;
    }
    if (!req.id || !req.method) {
      write({
        id: req.id ?? 'unknown',
        ok: false,
        error: { message: 'request requires { id, method }', kind: 'runtime' },
      });
      return;
    }
    // Sequentially serve requests on the single page. Parent can pipeline by
    // sending more requests; we serialize them inside the sidecar so a goto
    // doesn't race a click.
    queue = queue.then(async () => {
      const reply = await dispatch(state, req);
      write(reply);
    });
  });
  rl.once('close', () => {
    void shutdownAndExit(0);
  });
  // Defensive: if our stdout pipe breaks (parent died mid-write), Node
  // would otherwise throw an uncaught EPIPE on the next write. Treat
  // it as a signal to clean up gracefully instead.
  process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
      void shutdownAndExit(0);
    }
  });
}

main().catch((err) => {
  process.stderr.write(`sidecar fatal: ${errMsg(err)}\n`);
  void shutdownAndExit(1);
});
