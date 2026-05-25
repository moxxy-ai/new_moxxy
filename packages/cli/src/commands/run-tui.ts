import {
  createInteractivePermissionResolver,
  InteractiveSession,
  loadPreferences,
  type InteractiveBootStep,
} from '@moxxy/plugin-cli';
import { render } from 'ink';
import React from 'react';
import type {
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
} from '@moxxy/sdk';
import { loadConfig } from '@moxxy/config';
import {
  connectRemoteSession,
  isRunnerUp,
  startRunnerServer,
  runnerSocketPath,
  type RemoteSession,
  type RunnerServer,
} from '@moxxy/runner';
import { setupSession, setupSessionWithConfig, type BootStep } from '../setup.js';
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
  if (mode === 'attach') return await runAttachedTui(argv);
  return await runSelfHostedTui(argv, tuiOpts, mode === 'standalone');
}

/** Thin-client mode: drive a `RemoteSession` against the running runner. */
async function runAttachedTui(argv: ParsedArgv): Promise<number> {
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
    process.stderr.write(`failed to attach to the runner at ${runnerSocketPath()}: ${errMsg(err)}\n`);
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
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals | 'normal'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
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
