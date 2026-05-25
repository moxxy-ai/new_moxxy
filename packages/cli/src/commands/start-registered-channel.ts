import {
  connectRemoteSession,
  isRunnerUp,
  runnerSocketPath,
  startRunnerServer,
  type RunnerServer,
} from '@moxxy/runner';
import {
  argvToSetupOptions,
  bootSessionWithConfig,
  hasBoolFlag,
  stringFlag,
} from '../argv-helpers.js';
import { setupSessionWithConfig } from '../setup.js';
import { printError } from '../errors.js';
import type { ParsedArgv } from '../argv.js';
import { chooseClientMode, collectExtraFlags } from './client-mode.js';

/**
 * Run a registered channel by name, headlessly (no wizard, no TUI hand-off).
 *
 * Like `moxxy tui`, a channel is a thin client of the runner:
 *  - a runner is up (and not `--standalone`) -> attach over the socket and run
 *    the channel against a RemoteSession.
 *  - otherwise -> boot a local session and, unless `--standalone`, open the
 *    runner socket so other clients can attach too (Option A).
 */
export async function startRegisteredChannel(name: string, argv: ParsedArgv): Promise<number> {
  const standalone = hasBoolFlag(argv, 'standalone');
  const mode = chooseClientMode({ standalone, runnerUp: standalone ? false : await isRunnerUp() });
  if (mode === 'attach') return runAttachedChannel(name, argv);
  return runSelfHostedChannel(name, argv, mode === 'standalone');
}

/** Thin-client mode: run the channel against a RemoteSession. */
async function runAttachedChannel(name: string, argv: ParsedArgv): Promise<number> {
  // Register plugins so the channel factory is available, but skip init hooks
  // (no daemons - the runner owns those) and provider activation (turns run on
  // the runner). This is the "load the factory, don't boot a session" path.
  const setup = await setupSessionWithConfig({
    ...argvToSetupOptions(argv),
    skipKeyPrompt: true,
    tolerateNoProvider: true,
    skipProviderActivation: true,
    skipInitHooks: true,
    disableSessionPersistence: true,
  });

  const def = setup.session.channels.get(name);
  if (!def) {
    printError(unknownChannelMessage(name, setup.session.channels.list()));
    return 2;
  }

  let remote;
  try {
    remote = await connectRemoteSession({ role: name });
  } catch (err) {
    printError(`failed to attach to the runner at ${runnerSocketPath()}: ${errMsg(err)}`);
    return 1;
  }

  const configOpts = (setup.config.channels?.[name] ?? {}) as Record<string, unknown>;
  const channel = def.create({
    cwd: process.cwd(),
    vault: setup.vault,
    logger: setup.session.logger,
    options: { ...configOpts, ...argv.flags },
  });
  remote.setPermissionResolver(channel.permissionResolver);

  const handle = await channel.start({
    session: remote,
    model: stringFlag(argv, 'model'),
    ...collectExtraFlags(argv),
  } as never);

  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await handle.stop('SIGINT');
    await remote.close().catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  // Runner gone: exit non-zero so a supervisor (systemd/launchd) restarts us,
  // and we reattach to whatever runner is up next.
  remote.onClose(() => {
    if (stopping) return;
    process.stderr.write('runner disconnected - exiting (will reattach on restart).\n');
    void shutdown(1);
  });

  await handle.running;
  return 0;
}

/** Self-host mode: boot a local session and (unless standalone) open the socket. */
async function runSelfHostedChannel(
  name: string,
  argv: ParsedArgv,
  standalone: boolean,
): Promise<number> {
  // `skipKeyPrompt: true` - channels like telegram run for hours; if the model
  // key resolves later from env/vault when a turn fires, that's fine. The
  // interactive readline prompt would race the channel's event loop.
  const { session, vault, config } = await bootSessionWithConfig(argv, { skipKeyPrompt: true });

  const def = session.channels.get(name);
  if (!def) {
    printError(unknownChannelMessage(name, session.channels.list()));
    return 2;
  }

  const configOpts = (config.channels?.[name] ?? {}) as Record<string, unknown>;
  const channel = def.create({
    cwd: process.cwd(),
    vault,
    logger: session.logger,
    options: { ...configOpts, ...argv.flags },
  });

  session.setPermissionResolver(channel.permissionResolver);

  // Open the runner socket so other clients can attach while this channel is
  // up (Option A). A lost race just means no sharing, not an error.
  let runnerServer: RunnerServer | null = null;
  if (!standalone) {
    try {
      runnerServer = await startRunnerServer(session);
    } catch {
      runnerServer = null;
    }
  }

  const handle = await channel.start({
    session,
    model: stringFlag(argv, 'model'),
    ...collectExtraFlags(argv),
  } as never);

  const shutdown = async (): Promise<void> => {
    await runnerServer?.close().catch(() => undefined);
    await handle.stop('SIGINT');
    // Fire onShutdown hooks so plugins can flush (memory journal, vault, etc.).
    await session.close('SIGINT').catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await handle.running;
  return 0;
}

function unknownChannelMessage(
  name: string,
  available: ReadonlyArray<{ name: string; description: string }>,
): string {
  return (
    `unknown channel: ${name}\n  Available:\n` +
    available.map((d) => `    ${d.name} - ${d.description}\n`).join('')
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
