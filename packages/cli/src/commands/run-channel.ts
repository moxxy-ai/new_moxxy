import { isRunnerUp } from '@moxxy/runner';
import type { ParsedArgv } from '../argv.js';
import { bootSessionWithConfig, hasBoolFlag } from '../argv-helpers.js';
import { printError } from '../errors.js';
import { runTuiWithBootstrap } from './run-tui.js';
import { startRegisteredChannel } from './start-registered-channel.js';
import { runChannelSubcommand } from './channels.js';

/**
 * Smart channel dispatcher. Routes the `moxxy <channel>` invocation
 * through the appropriate frontend:
 *
 *   - tui      -> mounts Ink early, threads bootstrap progress into the boot screen
 *   - any      -> if the channel declares an `interactiveCommand` and we're on a
 *                 TTY (and not opting out), run that subcommand (a channel's
 *                 interactive setup); otherwise fall through to the headless
 *                 channel runner.
 *
 * The headless path lives in `start-registered-channel.ts`. The CLI knows
 * nothing about any specific channel here: the interactive-setup hook is
 * declared by the channel itself via `ChannelDef.interactiveCommand`.
 */
export async function runChannelByName(name: string, argv: ParsedArgv): Promise<number> {
  // The `tui` channel mounts its UI BEFORE running setup so the user
  // sees the logo + boot checklist instantly. Delegate to the TUI
  // helper, which threads progress callbacks into the bootstrap and
  // wires the permission resolver post-boot. (tui is the CLI's own
  // default UI, not a cross-package concern.)
  if (name === 'tui') return runTuiWithBootstrap(argv);

  // Light boot to read the channel registry without activating a provider:
  // the interactive-command path (e.g. a setup wizard) does not run a turn.
  const { session, vault, config } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    tolerateNoProvider: true,
    skipProviderActivation: true,
  });

  const def = session.channels.get(name);
  if (!def) {
    printError(
      `unknown channel: ${name}\n  Available:\n` +
        session.channels.list().map((d) => `    ${d.name} - ${d.description}\n`).join(''),
    );
    return 2;
  }

  // A channel may declare an interactive setup subcommand shown by default
  // for TTY users. Bypass on:
  //   - non-TTY (cron / systemd / piped)
  //   - `--no-wizard` / `__skipWizard` (explicit opt-out / wizard hand-off,
  //     so the recursive call doesn't trampoline back into the menu)
  //   - `--standalone` (the user explicitly opts out of attaching)
  //   - a runner already being up: the user wants to attach/run, not
  //     configure, so go straight to the headless runner.
  if (
    def.interactiveCommand &&
    process.stdin.isTTY === true &&
    argv.flags['no-wizard'] !== true &&
    argv.flags['__skipWizard'] !== true &&
    !hasBoolFlag(argv, 'standalone') &&
    !(await isRunnerUp())
  ) {
    return runChannelSubcommand(def, def.interactiveCommand, { session, vault, config, argv });
  }

  return startRegisteredChannel(name, argv);
}
