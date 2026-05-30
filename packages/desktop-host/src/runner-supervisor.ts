/**
 * Owns the lifecycle of the connection to a moxxy runner.
 *
 *   1. Resolve the moxxy CLI. If absent → `cli-missing` phase with a
 *      clear hint; never silently waits forever.
 *   2. Probe the canonical runner socket. If a `moxxy serve` is
 *      already alive (e.g. user has `moxxy tui` open), adopt it.
 *      Otherwise spawn one ourselves and supervise it.
 *   3. Connect a {@link RemoteSession} client via `@moxxy/runner`
 *      and surface it. No custom JSON-RPC plumbing — the moxxy
 *      runner package owns the wire format.
 *   4. Self-heal: if the connection drops or the spawned child dies,
 *      we transition to `reconnecting` and loop back to resolution.
 *
 * Every state transition emits a `change` event so the IPC layer can
 * forward it to the renderer without polling. A `snapshot()` accessor
 * still exists for late mounts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';

import {
  connectRemoteSession,
  type RemoteSession,
} from '@moxxy/runner';

import type {
  ConnectionPhase,
  ConnectionSnapshot,
} from '@moxxy/desktop-ipc-contract';
import {
  augmentedPaths,
  nodeLauncher,
  resolveMoxxyCli,
  spawnPath,
  type CliInvocation,
} from './cli-resolver';
import { redactSecrets } from './security';

const PROBE_TIMEOUT_MS = 250;
const SOCKET_WAIT_MS = 20_000;
const SOCKET_POLL_MS = 200;
const RECONNECT_BACKOFF_MS = 2_000;
const LOG_RING_SIZE = 200;

export class RunnerSupervisor extends EventEmitter {
  private currentPhase: ConnectionPhase = { phase: 'idle' };
  private cliPath: string | null = null;
  private attempts = 0;
  private logRing: Array<{ stream: 'stdout' | 'stderr'; line: string }> = [];
  private session: RemoteSession | null = null;
  private child: ChildProcess | null = null;
  private retryNotify: () => void = () => {};
  private stopped = false;
  /**
   * Currently active desk's cwd. The supervisor passes this as the
   * spawned moxxy serve's cwd so moxxy's config loader picks up the
   * desk's project-local `moxxy.config.yaml` + scopes its session
   * log there. Switching desks calls [`setCwd`] which restarts.
   */
  private cwd: string | null = null;

  constructor(
    private readonly socketPath: string = process.env.MOXXY_RUNNER_SOCKET ??
      path.join(homedir(), '.moxxy', 'serve.sock'),
  ) {
    super();
  }

  /**
   * Tell the supervisor which directory the runner should treat as
   * its cwd. If we're already attached, tear down and reconnect so
   * the new desk's config + session files take effect.
   */
  async setCwd(cwd: string | null): Promise<void> {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    if (this.session) {
      // Close the session — the run loop will then attempt to spawn
      // a fresh runner in the new directory.
      const session = this.session;
      this.session = null;
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      if (this.child) {
        this.child.kill();
        this.child = null;
      }
      this.forceRetry();
    }
  }

  snapshot(): ConnectionSnapshot {
    return {
      phase: this.currentPhase,
      cliPath: this.cliPath,
      attempts: this.attempts,
      log: this.logRing.slice(),
    };
  }

  /** The connected `RemoteSession`, or null. Used by IPC handlers to
   *  forward turns / setProvider / setMode calls. */
  remote(): RemoteSession | null {
    return this.session;
  }

  /**
   * Re-read the runner's session info and re-emit the `connected` phase, so
   * the renderer sees state that changed mid-session — notably `activeProvider`
   * after a `setProvider` (the runner boots with no provider during onboarding;
   * without this re-emit the app's `connectedWithoutProvider` gate never clears
   * and onboarding loops). No-op unless currently connected.
   */
  refreshConnectedInfo(): void {
    if (!this.session || this.currentPhase.phase !== 'connected') return;
    try {
      const info = this.session.getInfo();
      this.setPhase({
        phase: 'connected',
        socket: this.socketPath,
        sessionId: String(info.sessionId ?? '(unknown)'),
        activeProvider: info.activeProvider ?? null,
        activeMode: info.activeMode ?? null,
      });
    } catch {
      /* session torn down mid-refresh — the run loop re-derives the phase */
    }
  }

  /** Kick the loop out of a backoff wait so the user's Retry button
   *  is responsive. No-op when already trying. */
  forceRetry(): void {
    this.retryNotify();
  }

  /** Tear down the current runner (if any) and loop back to re-resolve
   *  the CLI + respawn — used after the CLI is updated so the new
   *  binary is picked up immediately, without a relaunch. */
  async restart(): Promise<void> {
    if (this.session) {
      const s = this.session;
      this.session = null;
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.forceRetry();
  }

  /** Run the supervision loop. Returns immediately; the loop runs
   *  in the background for the lifetime of the process. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.attempt();
      } catch (err) {
        // attempt() sets the phase itself for known failures. This
        // catch is the safety net for unexpected throws.
        if (this.currentPhase.phase !== 'failed' && this.currentPhase.phase !== 'cli-missing') {
          const msg = err instanceof Error ? err.message : String(err);
          this.attempts += 1;
          this.setPhase({
            phase: 'reconnecting',
            reason: msg,
            attempt: this.attempts,
          });
        }
      }
      await this.waitForRetry();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.retryNotify();
    if (this.session) {
      try {
        await this.session.close();
      } catch {
        /* ignore */
      }
      this.session = null;
    }
    if (this.child) {
      await terminateChild(this.child);
      this.child = null;
    }
  }

  // ------- internals -------

  private async attempt(): Promise<void> {
    this.setPhase({ phase: 'resolving-cli' });
    const cli = resolveMoxxyCli({ extraPaths: augmentedPaths() });
    if (!cli) {
      this.cliPath = null;
      this.setPhase({
        phase: 'cli-missing',
        hint:
          'moxxy CLI not found on PATH. Run `npm install -g @moxxy/cli` or set MOXXY_CLI_ENTRY.',
      });
      throw new Error('cli missing');
    }
    this.cliPath = displayPath(cli);

    // If a workspace is bound, we MUST own the runner so its cwd is
    // the workspace directory — adopting whatever serve is already on
    // the socket would inherit the wrong cwd and silently leak file
    // writes outside the workspace.
    const adopt = this.cwd === null ? await this.probeSocket() : false;

    if (!adopt) {
      // Kill the foreign serve if one is on the socket so we can take
      // over. Without this the bind below would race with the
      // existing listener.
      if (this.cwd !== null && (await this.probeSocket())) {
        this.pushLog(
          'stderr',
          'workspace bound — refusing to adopt foreign serve; replacing it',
        );
      }
      this.ensureSocketDir();
      this.cleanupStaleSocket();
      const child = this.spawnServe(cli);
      this.child = child;
      const pid = child.pid;
      this.setPhase({
        phase: 'spawning',
        cliPath: this.cliPath,
        socket: this.socketPath,
        ...(typeof pid === 'number' ? { pid } : {}),
      });
      child.on('exit', (code, signal) => {
        this.pushLog('stderr', `child exited code=${code} signal=${signal}`);
      });
    } else {
      this.setPhase({
        phase: 'adopting',
        socket: this.socketPath,
      });
    }

    // Pass the spawned child (null when adopting) so a serve that dies
    // before binding fails fast instead of waiting out the 20 s poll.
    await this.waitForSocket(this.child);

    this.setPhase({
      phase: 'attaching',
      socket: this.socketPath,
    });
    let session: RemoteSession;
    try {
      session = await connectRemoteSession({
        role: 'desktop',
        socketPath: this.socketPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A previously-installed older moxxy may have left a v1 daemon
      // bound to ~/.moxxy/serve.sock. The desktop's client is v2 →
      // mismatch. Kill the foreign daemon, sweep the socket, and let
      // the run loop respin so we spawn our own bundled serve.
      if (/protocol mismatch/i.test(msg)) {
        this.pushLog(
          'stderr',
          `protocol mismatch on attach (${msg}); killing stale runner and respawning`,
        );
        await this.killForeignRunner();
        throw new Error(`stale runner replaced (${msg})`);
      }
      throw err;
    }
    this.session = session;

    const info = session.getInfo();
    this.setPhase({
      phase: 'connected',
      socket: this.socketPath,
      sessionId: String(info.sessionId ?? '(unknown)'),
      activeProvider: info.activeProvider ?? null,
      activeMode: info.activeMode ?? null,
    });

    // Block here until the session drops. `onClose` fires exactly once
    // (per RemoteSession's docs) when the runner link tears down.
    await new Promise<void>((resolve) => {
      session.onClose(() => resolve());
    });

    this.attempts += 1;
    this.setPhase({
      phase: 'reconnecting',
      reason: 'runner disconnected',
      attempt: this.attempts,
    });
    this.session = null;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  private probeSocket(): Promise<boolean> {
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
      socket.connect(this.socketPath);
    });
  }

  private ensureSocketDir(): void {
    const dir = path.dirname(this.socketPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        this.pushLog('stderr', `could not create socket dir ${dir}: ${(e as Error).message}`);
      }
    }
  }

  private cleanupStaleSocket(): void {
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
        this.pushLog('stderr', `removed stale socket ${this.socketPath}`);
      } catch (e) {
        this.pushLog(
          'stderr',
          `could not remove stale socket: ${(e as Error).message}`,
        );
      }
    }
  }

  private spawnServe(cli: CliInvocation): ChildProcess {
    const cliDir = cli.kind === 'direct' ? path.dirname(cli.bin) : path.dirname(cli.entry);
    const env = {
      ...process.env,
      // GUI launches lack the shell PATH, so moxxy's `#!/usr/bin/env node`
      // shebang can't find node → serve exits 127 and the desktop loops on
      // "Lost the runner. Reconnecting…". Put node's dir (= the resolved
      // CLI's dir) + the known install locations on PATH.
      PATH: spawnPath([cliDir]),
      MOXXY_RUNNER_SOCKET: this.socketPath,
      // Desktop owns the UI; we don't need the co-attached web
      // surface, and binding its fixed port (4040) breaks the moment
      // a second workspace runner spawns.
      MOXXY_NO_WEB_SURFACE: '1',
    };
    const spawnOpts: import('node:child_process').SpawnOptions = {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (this.cwd) spawnOpts.cwd = this.cwd;
    let proc: ChildProcess;
    if (cli.kind === 'direct') {
      proc = spawn(cli.bin, ['serve'], spawnOpts);
    } else {
      // No system `node` on a GUI launch — run the bundled CLI with
      // Electron's own Node (ELECTRON_RUN_AS_NODE), merged onto the PATH
      // env above. Falls back to plain `node` outside Electron.
      const { command, env: nodeEnv } = nodeLauncher();
      proc = spawn(command, [cli.entry, 'serve'], {
        ...spawnOpts,
        env: { ...env, ...nodeEnv },
      });
    }

    proc.stdout?.on('data', (chunk) => this.consumeLog('stdout', chunk));
    proc.stderr?.on('data', (chunk) => this.consumeLog('stderr', chunk));
    return proc;
  }

  /** Find and SIGTERM whatever process is bound to our socket, then
   *  unlink the file so the next spawn binds cleanly. macOS / Linux. */
  private async killForeignRunner(): Promise<void> {
    if (process.platform === 'win32') return;
    const pid = await new Promise<number | null>((resolve) => {
      let out = '';
      try {
        const child = spawn('lsof', ['-t', this.socketPath], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout.on('data', (b) => {
          out += b.toString();
        });
        child.on('error', () => resolve(null));
        child.on('close', () => {
          const parsed = parseInt(out.trim().split('\n')[0] ?? '', 10);
          resolve(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
        });
      } catch {
        resolve(null);
      }
    });
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400));
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    try {
      const fs = await import('node:fs');
      fs.unlinkSync(this.socketPath);
    } catch {
      /* fine */
    }
  }

  private async waitForSocket(child: ChildProcess | null = null): Promise<void> {
    const deadline = Date.now() + SOCKET_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.probeSocket()) return;
      // The serve we spawned died before binding — no point polling for
      // 20 s; surface it now so the run loop retries / reports.
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(
          `moxxy serve exited before binding ${this.socketPath} ` +
            `(code=${child.exitCode} signal=${child.signalCode})`,
        );
      }
      await sleep(SOCKET_POLL_MS);
    }
    throw new Error(
      `moxxy serve did not bind ${this.socketPath} within ${SOCKET_WAIT_MS} ms`,
    );
  }

  private async waitForRetry(): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, RECONNECT_BACKOFF_MS);
      this.retryNotify = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.retryNotify = () => {};
  }

  private setPhase(phase: ConnectionPhase): void {
    this.currentPhase = phase;
    this.emit('change', this.snapshot());
  }

  private consumeLog(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line) this.pushLog(stream, line);
    }
  }

  private pushLog(stream: 'stdout' | 'stderr', line: string): void {
    // Redact before buffering: this ring is shipped to the renderer in
    // every snapshot() and shown in the connection diagnostics, so a
    // secret a plugin echoed to stdout must never make it across.
    this.logRing.push({ stream, line: redactSecrets(line) });
    if (this.logRing.length > LOG_RING_SIZE) {
      this.logRing.splice(0, this.logRing.length - LOG_RING_SIZE);
    }
  }
}

function displayPath(cli: CliInvocation): string {
  return cli.kind === 'direct' ? cli.bin : cli.entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SIGKILL_GRACE_MS = 2_000;

/**
 * SIGTERM the child, then SIGKILL if it hasn't exited within the grace
 * window — so a wedged `moxxy serve` can't survive as a zombie holding
 * the socket after the desktop quits. Resolves once the child is gone or
 * the grace elapses.
 */
function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      resolve();
    }, SIGKILL_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
