import {
  createInteractivePermissionResolver,
  InteractiveSession,
  loadPreferences,
  type InteractiveBootStep,
} from '@moxxy/plugin-cli';
import { render } from 'ink';
import React from 'react';
import type {
  ChannelHandle,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
} from '@moxxy/sdk';
import { coAttachWebSurface } from './web-surface.js';
import { loadConfig } from '@moxxy/config';
import {
  connectRemoteSession,
  isRunnerUp,
  startRunnerServer,
  runnerSocketPath,
  type RemoteSession,
  type RunnerServer,
} from '@moxxy/runner';
import { existsSync, unlinkSync } from 'node:fs';
import { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { setupSession, setupSessionWithConfig, type BootStep } from '../setup.js';

/** Best-effort recovery for "I had an older `moxxy serve` running
 *  at v1 and the new client is v2" scenarios. Kill whatever PID is
 *  holding the socket, then unlink the socket file so the next
 *  spawn binds cleanly. macOS / Linux only — lsof on Windows is
 *  out of scope here. */
async function killStaleRunnerAt(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const pid = await new Promise<number | null>((resolve) => {
    if (process.platform === 'win32') return resolve(null);
    let out = '';
    try {
      const child = spawn('lsof', ['-t', socketPath], {
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
  // Drain any lingering socket file so the self-host bind doesn't
  // EADDRINUSE.
  try {
    unlinkSync(socketPath);
  } catch {
    /* may already be gone */
  }
  void Socket; // kept for parity with the desktop sweep helper.
}
import { argvToSetupOptions, hasBoolFlag, stringFlag } from '../argv-helpers.js';
import { chooseClientMode } from './client-mode.js';
import type { ParsedArgv } from '../argv.js';
import { cliVersion } from '../version.js';
import { runInitCommand } from './init.js';
import type { Session } from '@moxxy/core';

/**
 * `moxxy tui`. Three modes:
 *
 *  - **attach** (default when a runner is up): connect to the running
 *    `moxxy serve` as a thin client. No session boot - instant, and the
 *    conversation streams live + replays on attach.
 *  - **self-host** (default when no runner is up): boot a local Session AND
 *    open the runner socket (Option A) so other clients can attach while this
 *    TUI is open. Tears the socket down on exit.
 *  - **standalone** (`--standalone`): boot a local Session and do NOT open the
 *    socket - fully isolated, ≈ the pre-split behavior.
 */
export interface RunTuiOpts {
  /** Resume a persisted session by id. Seeds the EventLog from disk. */
  readonly resumeSessionId?: string;
}

export async function runTuiWithBootstrap(
  argv: ParsedArgv,
  tuiOpts: RunTuiOpts = {},
): Promise<number> {
  const standalone = hasBoolFlag(argv, 'standalone');
  const mode = chooseClientMode({ standalone, runnerUp: standalone ? false : await isRunnerUp() });
  if (mode === 'attach') return await runAttachedTui(argv, tuiOpts);
  return await runSelfHostedTui(argv, tuiOpts, mode === 'standalone');
}

/** Thin-client mode: drive a `RemoteSession` against the running runner. */
async function runAttachedTui(argv: ParsedArgv, tuiOpts: RunTuiOpts): Promise<number> {
  let promptHandler:
    | ((call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>)
    | null = null;
  const resolver = createInteractivePermissionResolver({
    name: 'tui',
    prompt: async (call, ctx) => {
      if (!promptHandler) return { mode: 'deny', reason: 'TUI not ready' };
      return promptHandler(call, ctx);
    },
  });

  let remote: RemoteSession;
  try {
    remote = await connectRemoteSession({ role: 'tui' });
  } catch (err) {
    const msg = errMsg(err);
    // A stale `moxxy serve` from a previous (older) install can hold
    // the socket open at a lower protocol version. Detect that and
    // recover by killing the stale daemon, then fall through to
    // self-host mode so the user isn't stranded.
    if (/protocol mismatch/i.test(msg)) {
      process.stderr.write(
        `stale runner detected at ${runnerSocketPath()} (${msg}); killing it and self-hosting.\n`,
      );
      await killStaleRunnerAt(runnerSocketPath()).catch(() => undefined);
      return await runSelfHostedTui(argv, tuiOpts, false);
    }
    process.stderr.write(`failed to attach to the runner at ${runnerSocketPath()}: ${msg}\n`);
    return 1;
  }
  // Register as the resolver for the turns this client starts.
  remote.setPermissionResolver(resolver);

  const prefs = await loadPreferences();
  const effectiveModel = stringFlag(argv, 'model') ?? prefs.model;
  const version = cliVersion();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => process.exit(0), 4000);
    force.unref?.();
    await remote.close().catch(() => undefined);
  };
  const onSignal = (): void => void shutdown().then(() => process.exit(0));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const instance = render(
    React.createElement(InteractiveSession, {
      session: remote,
      registerInteractiveResolver: (handler) => {
        promptHandler = handler;
      },
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(version ? { version } : {}),
      // Land directly in the (replayed) conversation rather than the splash.
      resumed: true,
    }),
  );

  // If the runner goes away, the session is gone - tear down the UI and tell
  // the user to reattach rather than leaving a frozen screen.
  remote.onClose(() => {
    if (shuttingDown) return;
    process.stderr.write('\nrunner disconnected - exiting. Re-run `moxxy tui` to reattach.\n');
    instance.unmount();
  });

  try {
    await instance.waitUntilExit();
  } finally {
    await shutdown();
  }
  return 0;
}

/**
 * Self-host / standalone mode. Boots a local Session (bootstrap-inverted so
 * the splash renders from the first frame) and - unless `--standalone` -
 * opens the runner socket so other clients can attach (Option A).
 */
async function runSelfHostedTui(
  argv: ParsedArgv,
  tuiOpts: RunTuiOpts,
  standalone: boolean,
): Promise<number> {
  if (process.stdin.isTTY) {
    const { sources } = await loadConfig({
      cwd: process.cwd(),
      ...(stringFlag(argv, 'config') ? { explicitPath: stringFlag(argv, 'config')! } : {}),
    });
    let needsInit = sources.length === 0;
    if (!needsInit) {
      try {
        const probe = await setupSession({
          ...argvToSetupOptions(argv),
          tolerateNoProvider: true,
          skipKeyPrompt: true,
          disableSessionPersistence: true,
        });
        if (!probe.providers.getActiveName()) needsInit = true;
      } catch {
        needsInit = true;
      }
    }
    if (needsInit) {
      const code = await runInitCommand(argv);
      if (code !== 0) return code;
    }
  }

  let promptHandler:
    | ((call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>)
    | null = null;
  const resolver = createInteractivePermissionResolver({
    name: 'tui',
    prompt: async (call, ctx) => {
      if (!promptHandler) return { mode: 'deny', reason: 'TUI not ready' };
      return promptHandler(call, ctx);
    },
  });

  const effectiveModel = stringFlag(argv, 'model') ?? (await loadPreferences()).model;
  const version = cliVersion();

  // Capture the resolved session + optional runner so shutdown can fire
  // `onShutdown` hooks and release the socket.
  let bootedSession: Session | null = null;
  let runnerServer: RunnerServer | null = null;
  let webHandle: ChannelHandle | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals | 'normal'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Force-exit guard for signal-driven shutdown: never hang holding the port /
    // a tunnel child if a stop() stalls. (Harmless on the normal-exit path, where
    // the process exits on its own and this unref'd timer is moot.)
    if (signal !== 'normal') {
      const force = setTimeout(() => process.exit(0), 4000);
      force.unref?.();
    }
    await webHandle?.stop('shutdown').catch(() => undefined);
    await runnerServer?.close().catch(() => undefined);
    const s = bootedSession;
    bootedSession = null;
    if (!s) return;
    try {
      await s.close(signal === 'normal' ? undefined : signal);
    } catch {
      // Best-effort; never block process exit on cleanup errors.
    }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const { waitUntilExit } = render(
    React.createElement(InteractiveSession, {
      bootstrap: async (progress: (step: InteractiveBootStep) => void) => {
        const result = await setupSessionWithConfig({
          ...argvToSetupOptions(argv),
          resolver,
          onProgress: (step: BootStep) => progress(toInteractiveStep(step)),
          ...(tuiOpts.resumeSessionId ? { resumeSessionId: tuiOpts.resumeSessionId } : {}),
        });
        bootedSession = result.session;
        // Option A: open the socket so other clients can attach while this TUI
        // is open. A lost race (someone else bound first) just means we run
        // without sharing - not an error.
        if (!standalone) {
          try {
            runnerServer = await startRunnerServer(result.session);
          } catch {
            runnerServer = null;
          }
        }
        // Co-attach the web surface to THIS session so `present_view` returns a
        // real URL (local by default — no public tunnel for the TUI). `write` is
        // suppressed: the URL flows back through present_view → the agent's reply,
        // and stdout would corrupt the Ink render.
        webHandle = await coAttachWebSurface({
          primary: 'tui',
          session: result.session,
          vault: result.vault,
          config: result.config,
          write: () => {},
        });
        return result.session;
      },
      registerInteractiveResolver: (handler) => {
        promptHandler = handler;
      },
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(version ? { version } : {}),
      ...(tuiOpts.resumeSessionId ? { resumed: true } : {}),
    }),
  );

  try {
    await waitUntilExit();
  } finally {
    await shutdown('normal');
  }
  return 0;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toInteractiveStep(step: BootStep): InteractiveBootStep {
  switch (step.kind) {
    case 'provider-activated':
      return { kind: 'provider-activated', detail: step.name };
    case 'provider-failed':
      return { kind: 'provider-failed', error: step.error };
    case 'plugins-registered':
      return { kind: 'plugins-registered', detail: `${step.count}` };
    case 'skills-loaded':
      return { kind: 'skills-loaded', detail: `${step.count}` };
    case 'config-loaded':
      return { kind: 'config-loaded' };
    case 'prefs-applied':
      return { kind: 'prefs-applied' };
    case 'init-hooks-done':
      return { kind: 'init-hooks-done' };
    case 'ready':
      return { kind: 'ready' };
  }
}
