/**
 * On boot, scan ~/.moxxy/desktop/sockets/ for stale per-workspace
 * runner sockets and tear down anything still bound. A previous
 * desktop process that crashed without running its shutdown handler
 * leaves both a unix-socket FD held by the orphaned moxxy serve AND
 * (on Linux/macOS) port-bound channels like the web surface on
 * 4040 — spawning a new runner on the same socket fails with
 * EADDRINUSE / silently reattaches to the dead one.
 *
 * Strategy:
 *
 *   1. For each .sock under the desktop sockets dir, probe it.
 *      Dead socket → just unlink. Alive → resolve the PID listening
 *      via `lsof` and SIGTERM it; SIGKILL after a short grace.
 *   2. Unlink the .sock so the next spawn binds cleanly.
 *
 * macOS + Linux only. Windows uses named pipes; the same race exists
 * but lsof isn't available — there we just unlink and trust Node to
 * report any conflict via the supervisor's existing error path.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 200;

export interface SweepLog {
  removed: string[];
  killed: number[];
  errors: string[];
}

export async function sweepStaleSockets(): Promise<SweepLog> {
  const log: SweepLog = { removed: [], killed: [], errors: [] };
  const dirs = candidateDirs();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      log.errors.push(`readdir ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.sock')) continue;
      const p = path.join(dir, name);
      const alive = await probe(p);
      if (alive) {
        const pid = await pidListeningOn(p);
        if (pid && pid !== process.pid) {
          await kill(pid, log);
        }
      }
      try {
        unlinkSync(p);
        log.removed.push(p);
      } catch (e) {
        log.errors.push(`unlink ${p}: ${(e as Error).message}`);
      }
    }
  }
  return log;
}

function candidateDirs(): string[] {
  return [
    path.join(homedir(), '.moxxy', 'desktop', 'sockets'),
    // Don't touch ~/.moxxy/serve.sock here — that's the legacy socket
    // shared with the TUI and external tools. The supervisor's own
    // cleanupStaleSocket handles that path conservatively.
  ];
}

function probe(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const done = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    try {
      socket.connect(socketPath);
    } catch {
      done(false);
    }
  });
}

/** Best-effort PID lookup via lsof. Returns null on Windows or if
 *  lsof isn't on PATH. */
function pidListeningOn(socketPath: string): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise<number | null>((resolve) => {
    let out = '';
    const child = spawn('lsof', ['-t', socketPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const pid = parseInt(out.trim().split('\n')[0] ?? '', 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

async function kill(pid: number, log: SweepLog): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
    log.killed.push(pid);
  } catch (e) {
    log.errors.push(`SIGTERM ${pid}: ${(e as Error).message}`);
    return;
  }
  // Grace then SIGKILL if still alive.
  await new Promise((r) => setTimeout(r, 400));
  try {
    process.kill(pid, 0); // 0 = liveness check
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already dead — good */
  }
}
