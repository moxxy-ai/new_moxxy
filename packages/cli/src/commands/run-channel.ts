import type { ParsedArgv } from '../argv.js';
import { runTuiWithBootstrap } from './run-tui.js';
import { startRegisteredChannel } from './start-registered-channel.js';
import { runTelegramWizard } from './telegram-wizard.js';

/**
 * Smart channel dispatcher. Routes the `moxxy <channel>` invocation
 * through the appropriate frontend:
 *
 *   - tui      → mounts Ink early, threads bootstrap progress into the boot screen
 *   - telegram → opens the interactive setup wizard (TTY only)
 *   - any      → falls through to the headless channel runner
 *
 * The headless path lives in `start-registered-channel.ts` so the
 * Telegram wizard can call into it without creating a circular import
 * back into this file.
 */
export async function runChannelByName(name: string, argv: ParsedArgv): Promise<number> {
  // The `tui` channel mounts its UI BEFORE running setup so the user
  // sees the logo + boot checklist instantly. Delegate to the TUI
  // helper, which threads progress callbacks into the bootstrap and
  // wires the permission resolver post-boot.
  if (name === 'tui') return runTuiWithBootstrap(argv);

  // Telegram has an interactive setup wizard shown by default for
  // TTY users. Bypass on:
  //   - non-TTY (cron / systemd / piped)
  //   - `--no-wizard` (explicit opt-out)
  //   - `__skipWizard` (set by the wizard itself when it hands off,
  //     so the recursive call doesn't trampoline back into the menu)
  const skipWizard =
    argv.flags['no-wizard'] === true ||
    argv.flags['__skipWizard'] === true ||
    process.stdin.isTTY !== true;
  if (name === 'telegram' && !skipWizard) return runTelegramWizard(argv);

  return startRegisteredChannel(name, argv);
}
