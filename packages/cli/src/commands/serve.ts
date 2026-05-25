import type { Channel, ChannelDef, ChannelHandle } from '@moxxy/sdk';
import { startRunnerServer, runnerSocketPath, type RunnerServer } from '@moxxy/runner';
import type { ParsedArgv } from '../argv.js';
import { bootSessionWithConfig, hasBoolFlag, helpRequested, stringFlag } from '../argv-helpers.js';
import { colors } from '../colors.js';
import { formatHelp } from './help-format.js';
import {
  getServiceStatus,
  installAndStartService,
  serviceLogPath,
  servicePlatform,
  stopAndUninstallService,
  type ServiceSpec,
} from './service/index.js';

/**
 * `moxxy serve` - the runner. Owns one Session + the agentic loop, runs the
 * background daemons (scheduler, webhooks), and exposes the session over a
 * local socket so thin clients (`moxxy tui`, `moxxy telegram`, ...) can attach.
 *
 * By default serve starts **bare**: no channels in-process - you launch each
 * channel as its own command and it attaches over the socket. `--all` instead
 * starts every registered channel in-process up front (the pre-split
 * behavior), sharing the one event log.
 *
 * The set of channels is discovered at runtime from the session's channel
 * registry - adding a new channel plugin needs no change here. Background
 * daemons are enumerated by `BACKGROUND_UNITS` below; that list is short and
 * stable (just scheduler + webhooks today).
 *
 * `--except <name1,name2,...>` skips named units (only meaningful with
 * `--all`). Names match the channel's `name` field or a background-unit id.
 */

interface BackgroundUnit {
  readonly id: string;
  readonly describe: string;
  /** Stop the unit's runtime without unloading its plugin. Idempotent. */
  readonly stop: (setup: SetupHandle) => Promise<void>;
}

interface SetupHandle {
  readonly scheduler: { readonly poller: { stop(): Promise<void> } };
  readonly webhooks: { readonly stop: () => Promise<void> };
}

const BACKGROUND_UNITS: ReadonlyArray<BackgroundUnit> = [
  {
    id: 'scheduler',
    describe: 'cron + one-shot scheduled prompts',
    stop: async ({ scheduler }) => scheduler.poller.stop(),
  },
  {
    id: 'webhooks',
    describe: 'HTTP listener for external webhook deliveries',
    stop: async ({ webhooks }) => webhooks.stop(),
  },
];

const HELP = formatHelp({
  title: 'moxxy serve',
  tagline:
    'the runner: owns one session + the agentic loop, exposes it over a socket for clients to attach',
  sections: [
    {
      title: 'FLAGS',
      rows: [
        ['--all', 'also start every registered channel in-process (default: bare runner)'],
        [
          '--except <list>',
          'with --all: comma-separated unit names to skip (channel name OR background unit id)',
        ],
        ['--background', 'install + start as a launchd / systemd --user unit and exit'],
        ['--stop', 'stop + uninstall the background unit'],
        ['--status', 'report whether the background unit is loaded + running'],
        ['--config <path>', 'use a specific moxxy.config.ts'],
        ['--model <id>', 'override the default model for the session'],
        ['--verbose', 'verbose logging'],
      ],
    },
    {
      title: 'EXAMPLES',
      rows: [
        ['moxxy serve', 'bare runner: session + daemons + socket, no channels (^C to stop)'],
        ['moxxy tui', 'in another terminal, attaches to the running runner'],
        ['moxxy serve --all', 'also start every channel in-process up front'],
        ['moxxy serve --all --except http', 'foreground, all channels except HTTP'],
        ['moxxy serve --background', 'install + start as an OS unit, exit'],
        ['moxxy serve --stop', 'tear down the background unit'],
        ['moxxy serve --status', 'show whether the background unit is running'],
      ],
    },
    {
      title: 'NOTES',
      rows: [
        [
          'Clients',
          'Once serve is up, `moxxy tui` / `moxxy telegram` / `moxxy http` attach to it over ' +
            'the socket instead of booting their own session. Without a runner they self-host ' +
            'one (and open the socket); pass --standalone to stay fully isolated.',
        ],
        [
          'Channel discovery',
          'Channels are read from the live session registry — newly installed channel ' +
            'plugins are picked up automatically.',
        ],
        [
          'Background units',
          'scheduler + webhooks. Their daemons start automatically when their plugins ' +
            "load; --except stops them after boot without disabling the plugin's tools.",
        ],
        [
          'Permissions',
          'Multiple interactive channels on one session share one permission resolver. ' +
            'serve picks the first-started channel\'s resolver; if you mix interactive ' +
            "channels with conflicting policies, run them as separate `moxxy service` units instead.",
        ],
      ],
    },
  ],
});

export async function runServeCommand(argv: ParsedArgv): Promise<number> {
  if (helpRequested(argv)) {
    process.stdout.write(HELP);
    return 0;
  }

  const except = parseExcept(stringFlag(argv, 'except'));
  const all = hasBoolFlag(argv, 'all');

  if (hasBoolFlag(argv, 'stop')) return await runServeStop();
  if (hasBoolFlag(argv, 'status')) return await runServeStatus(except, all);
  if (hasBoolFlag(argv, 'background')) return await runServeBackground(except, all);
  return await runServeForeground(argv, except, all);
}

function serveSpec(except: Set<string>, all = false): ServiceSpec {
  const args = ['serve'];
  if (all) args.push('--all');
  if (all && except.size > 0) {
    args.push('--except', [...except].join(','));
  }
  return {
    id: 'serve',
    description:
      'moxxy serve — every channel + scheduler + webhooks in ONE process, sharing a session',
    execArgs: args,
  };
}

async function runServeBackground(except: Set<string>, all: boolean): Promise<number> {
  if (servicePlatform() === 'unsupported') {
    process.stderr.write(
      colors.red(`background mode is unsupported on this platform (${process.platform})`) +
        '\n' +
        colors.dim('  Only macOS (launchd) and Linux (systemd --user) are wired up.\n') +
        colors.dim('  Run `moxxy serve` in the foreground instead.\n'),
    );
    return 1;
  }
  const spec = serveSpec(except, all);
  const result = await installAndStartService(spec);
  if (!result.ok) {
    process.stderr.write(`${colors.red('failed')}  ${colors.dim(result.message)}\n`);
    return 1;
  }
  process.stdout.write(`${colors.bold('started')}  ${colors.dim(result.message)}\n`);
  process.stdout.write(
    colors.dim(
      `         logs:   ${result.logPath}\n` +
        `         manage: moxxy serve --status | moxxy serve --stop\n` +
        `         exec:   ${spec.execArgs.join(' ')}\n`,
    ),
  );
  return 0;
}

async function runServeStop(): Promise<number> {
  if (servicePlatform() === 'unsupported') {
    process.stderr.write(
      colors.red(`background mode is unsupported on this platform (${process.platform})`) + '\n',
    );
    return 1;
  }
  const spec = serveSpec(new Set());
  const result = await stopAndUninstallService(spec);
  process.stdout.write(
    `${result.ok ? colors.bold('stopped') : colors.red('failed')}  ${colors.dim(result.message)}\n`,
  );
  return result.ok ? 0 : 1;
}

async function runServeStatus(except: Set<string>, all: boolean): Promise<number> {
  const platform = servicePlatform();
  if (platform === 'unsupported') {
    process.stdout.write(colors.red(`background mode is unsupported on this platform`) + '\n');
    return 1;
  }
  const spec = serveSpec(except, all);
  const status = await getServiceStatus(spec);
  const rows: Array<[string, string]> = [
    ['platform', platform],
    ['installed', status.installed ? 'yes' : 'no'],
    ['running', status.running ? 'yes' : 'no'],
  ];
  if (status.unitPath) rows.push(['unit', status.unitPath]);
  rows.push(['log', status.logPath ?? serviceLogPath(spec)]);
  const col = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    process.stdout.write(`${colors.bold(k.padEnd(col))}  ${colors.dim(v)}\n`);
  }
  return 0;
}

async function runServeForeground(
  argv: ParsedArgv,
  except: Set<string>,
  all: boolean,
): Promise<number> {
  const setup = await bootSessionWithConfig(argv, { skipKeyPrompt: true });
  const { session, vault, config, scheduler, webhooks } = setup;
  const setupHandle: SetupHandle = { scheduler, webhooks };

  // Expose the session over the socket FIRST - this is what makes serve a
  // runner. If the bind fails, another runner already owns the socket, and
  // there's no point continuing (we'd be a second, unreachable session).
  let runnerServer: RunnerServer;
  try {
    runnerServer = await startRunnerServer(session);
  } catch (err) {
    process.stderr.write(
      colors.red(`failed to open the runner socket at ${runnerSocketPath()}: ${errMsg(err)}\n`),
    );
    process.stderr.write(
      colors.dim(
        '  Another runner may already be running (a `moxxy serve` or a self-hosting `moxxy tui`).\n' +
          '  Stop it first, or just attach with `moxxy tui`.\n',
      ),
    );
    return 1;
  }

  const allBackgroundIds = new Set(BACKGROUND_UNITS.map((u) => u.id));
  const allChannelDefs = session.channels.list();
  const allChannelNames = new Set(allChannelDefs.map((d) => d.name));
  const allKnown = new Set([...allBackgroundIds, ...allChannelNames]);
  const unknownExcept = all ? [...except].filter((n) => !allKnown.has(n)) : [];

  // Stop excluded background units BEFORE starting channels so the user
  // never sees a brief listener flap.
  const stoppedBackground: string[] = [];
  for (const unit of BACKGROUND_UNITS) {
    if (except.has(unit.id)) {
      try {
        await unit.stop(setupHandle);
        stoppedBackground.push(unit.id);
      } catch (err) {
        process.stderr.write(
          colors.yellow(`warning: failed to stop ${unit.id}: ${errMsg(err)}\n`),
        );
      }
    }
  }

  // Start each non-excluded channel, only with --all. Bare runner (default)
  // starts none; clients attach over the socket instead. Failures (e.g. no
  // Telegram token) are collected and surfaced; serve keeps going.
  const started: Array<{ name: string; handle: ChannelHandle }> = [];
  const failed: Array<{ name: string; error: string }> = [];
  if (all) {
    let resolverSetByChannel = false;
    for (const def of allChannelDefs) {
      if (except.has(def.name)) continue;
      try {
        const handle = await startChannel(def, setup, !resolverSetByChannel);
        started.push({ name: def.name, handle });
        resolverSetByChannel = true;
      } catch (err) {
        failed.push({ name: def.name, error: errMsg(err) });
      }
    }
  }
  void vault;
  void config;

  const runningBackground = BACKGROUND_UNITS.filter((u) => !except.has(u.id)).map((u) => u.id);

  printStartupSummary({
    started: started.map((s) => s.name),
    failed,
    stoppedBackground,
    runningBackground,
    excluded: all ? [...except] : [],
    unknownExcept,
    runnerAddress: runnerServer.address,
    bare: !all,
  });

  // A bare runner is always "doing something" - it's listening for clients
  // and running daemons. There's no nothing-to-run exit anymore.
  await runUntilSignal(started, setup, runnerServer);
  return 0;
}

function parseExcept(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function startChannel(
  def: ChannelDef,
  setup: Awaited<ReturnType<typeof bootSessionWithConfig>>,
  installResolver: boolean,
): Promise<ChannelHandle> {
  const { session, vault, config } = setup;
  const channelOpts = (config.channels?.[def.name] ?? {}) as Record<string, unknown>;
  const channel: Channel = def.create({
    cwd: process.cwd(),
    vault,
    logger: session.logger,
    options: channelOpts,
  });
  // With multiple interactive channels active, the *first* successfully
  // started one wins the session-level permission resolver. Documented
  // in --help; users who need conflicting policies should run separate
  // `moxxy service` units.
  if (installResolver) {
    session.setPermissionResolver(channel.permissionResolver);
  }
  return channel.start({ session, ...channelOpts } as never);
}

interface StartupSummary {
  readonly started: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ name: string; error: string }>;
  readonly stoppedBackground: ReadonlyArray<string>;
  readonly runningBackground: ReadonlyArray<string>;
  readonly excluded: ReadonlyArray<string>;
  readonly unknownExcept: ReadonlyArray<string>;
  readonly runnerAddress: string;
  readonly bare: boolean;
}

/**
 * Best-effort hint for a channel that failed to start. Pattern-matches
 * common, channel-agnostic messages (port in use, …) into a one-line
 * fix-suggestion. Defensive: anything unrecognized falls back to the raw
 * error so we never hide what actually broke. Channel-specific failures
 * surface the channel's own error message.
 */
function failureHint(_name: string, error: string): string | null {
  const e = error.toLowerCase();
  if (e.includes('eaddrinuse') || e.includes('address already in use')) {
    return 'port is already in use — stop the conflicting process or pick another port in moxxy.config.ts.';
  }
  if (e.includes('eacces')) {
    return 'permission denied binding the port — pick a port >1024 or run with elevated privileges.';
  }
  return null;
}

function printStartupSummary(s: StartupSummary): void {
  const out = process.stdout;
  out.write(`${colors.bold('moxxy serve')} ${colors.dim(s.bare ? '(bare runner)' : '(--all)')}\n`);
  out.write(`  ${colors.bold('runner      ')} ${colors.dim(s.runnerAddress)}\n`);
  if (s.bare) {
    out.write(
      `  ${colors.bold('channels    ')} ${colors.dim('(none; attach with `moxxy tui`, `moxxy telegram`, ...)')}\n`,
    );
  } else if (s.started.length > 0) {
    out.write(`  ${colors.bold('channels    ')} ${s.started.join(', ')}\n`);
  } else {
    out.write(
      `  ${colors.bold('channels    ')} ${colors.dim('(none started — see failures below)')}\n`,
    );
  }
  if (s.runningBackground.length > 0) {
    out.write(`  ${colors.bold('background  ')} ${s.runningBackground.join(', ')}\n`);
  }
  if (s.stoppedBackground.length > 0) {
    out.write(
      `  ${colors.bold('skipped     ')} ${s.stoppedBackground.map((n) => colors.dim(n)).join(', ')}\n`,
    );
  }
  for (const f of s.failed) {
    const hint = failureHint(f.name, f.error);
    out.write(
      `  ${colors.yellow('failed      ')} ${f.name} ${colors.dim('— ' + f.error)}\n`,
    );
    if (hint) {
      out.write(`              ${colors.dim('→ ' + hint)}\n`);
    }
  }
  if (s.unknownExcept.length > 0) {
    out.write(
      `  ${colors.yellow('unknown     ')} ${s.unknownExcept.join(', ')} ${colors.dim(
        '(in --except but not a known channel or background unit)',
      )}\n`,
    );
  }

  // Make it explicit when only background units are alive — otherwise
  // a user can stare at the summary, see no channels, and assume serve
  // crashed when in fact scheduler + webhooks are humming along.
  if (s.started.length === 0 && s.runningBackground.length > 0) {
    out.write(
      `\n  ${colors.bold('note')}  ${colors.dim(
        'no channels are running, but background units are. The process will keep running ' +
          'so scheduled prompts fire and incoming webhooks are accepted. ' +
          'Configure a channel (e.g. `moxxy telegram`) and restart `moxxy serve` to add it.',
      )}\n`,
    );
  }
  out.write(colors.dim('\n  ^C to stop. Logs go to stderr.\n'));
}

async function runUntilSignal(
  started: ReadonlyArray<{ name: string; handle: ChannelHandle }>,
  setup: Awaited<ReturnType<typeof bootSessionWithConfig>>,
  runnerServer: RunnerServer,
): Promise<void> {
  let stopRequested = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopRequested) return;
    stopRequested = true;
    process.stderr.write(`\nstopping (${signal})…\n`);
    // Close the socket first so attached clients see the disconnect and stop
    // sending before the session tears down.
    await runnerServer.close().catch(() => undefined);
    for (const { name, handle } of started) {
      try {
        await handle.stop(signal);
      } catch (err) {
        process.stderr.write(`  ${name}: stop threw — ${errMsg(err)}\n`);
      }
    }
    // session.close() dispatches every plugin's onShutdown — scheduler
    // poller, webhooks listener, vault flush, etc.
    await setup.session.close(signal).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the loop alive even if every channel returns a never-settling
  // promise — setInterval at a long cadence costs ~nothing.
  setInterval(() => {}, 60_000).unref?.();

  if (started.length > 0) {
    // Resolve once ANY channel's `running` promise resolves — typically
    // means that channel crashed. Surface it and let signal handlers
    // tear the rest down.
    try {
      await Promise.race(started.map((s) => s.handle.running));
      process.stderr.write(colors.yellow('a channel stopped on its own — shutting down.\n'));
      await shutdown('CHANNEL_EXIT');
    } catch (err) {
      process.stderr.write(colors.red(`channel crashed: ${errMsg(err)}\n`));
      await shutdown('CHANNEL_CRASH');
    }
  } else {
    // No channels — idle on the background units; shutdown is the only
    // way out.
    await new Promise<void>(() => {
      /* never resolves */
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
