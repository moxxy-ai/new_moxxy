import { cancel, isCancel, log, outro, spinner, text } from '@clack/prompts';
import type { ChannelSubcommandContext } from '@moxxy/sdk';
import type { VaultStore } from '@moxxy/plugin-vault';
import { TelegramChannel, type PairingIssuedEvent } from './channel.js';

// Tiny zero-dep ANSI dim helper, so this flow stays inside the plugin.
const ANSI = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string): string => (ANSI ? `\x1b[2m${s}\x1b[22m` : s);

/**
 * Drive the bot-issued pairing flow end-to-end.
 *
 * Steps:
 *   1. Build a TelegramChannel directly from the subcommand ctx and wire the
 *      session's permission resolver.
 *   2. Subscribe to pairing-issued events BEFORE starting the bot so
 *      we can't race past the first /start.
 *   3. Start the bot in `pair` mode.
 *   4. Wait (with spinner) for the user to send /start in Telegram.
 *   5. Prompt the user for the 6-digit code the bot DM'd them; on
 *      mismatch let them retry (up to 3 tries inside the same window).
 *   6. On success, the channel persists the authorized chat id to the
 *      vault and DMs a confirmation; we then hand off SIGINT to keep
 *      the bot running until the user Ctrl-Cs.
 */
export async function runPairFlow(ctx: ChannelSubcommandContext): Promise<number> {
  const session = ctx.session;
  const channel = new TelegramChannel({
    vault: ctx.deps.vault as VaultStore,
    token: (ctx.deps.options?.['token'] as string | undefined) ?? undefined,
    logger: ctx.deps.logger as never,
  });
  session.setPermissionResolver(channel.permissionResolver);

  // Subscribe BEFORE start so the first /start can't fire before us.
  let issuedResolve: ((e: PairingIssuedEvent) => void) | null = null;
  const issued = new Promise<PairingIssuedEvent>((resolve) => {
    issuedResolve = resolve;
  });
  const unsubscribe = channel.onPairingIssued((e) => {
    issuedResolve?.(e);
    issuedResolve = null;
  });

  outro(dim('opening pairing window...'));

  const handle = await channel.start({ session, pair: true });

  // From here on we own the bot lifecycle. Any failure path needs to
  // call handle.stop() before returning.
  const stopBot = async (): Promise<void> => {
    unsubscribe();
    try {
      await handle.stop('wizard');
    } catch {
      /* ignore */
    }
  };

  const spin = spinner();
  spin.start('Waiting for /start from a Telegram chat...');

  let event: PairingIssuedEvent;
  try {
    event = await issued;
  } catch (err) {
    spin.stop('pairing aborted');
    log.error(`Pairing aborted: ${err instanceof Error ? err.message : String(err)}`);
    await stopBot();
    return 1;
  }
  spin.stop(`Code sent to Telegram chat ${event.chatId}.`);
  log.info(
    'Open the bot in Telegram. You should see the 6-digit code there.\n' +
      'Paste it below to authorize this chat.',
  );

  let confirmed = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entered = await text({
      message: 'Enter the 6-digit code',
      placeholder: '123456',
      validate: (v) => {
        const normalized = (v ?? '').replace(/\s+/g, '');
        if (!/^\d{6}$/.test(normalized)) return 'Enter the 6 digits the bot sent you';
        return undefined;
      },
    });
    if (isCancel(entered)) {
      cancel('pairing cancelled');
      await stopBot();
      return 0;
    }
    const result = await channel.confirmPairingCode(String(entered));
    if (result.ok) {
      log.success(`Paired ✓ - chat ${result.chatId} is authorized.`);
      confirmed = true;
      break;
    }
    if (result.reason === 'expired' || result.reason === 'no-window') {
      log.error(result.message);
      await stopBot();
      return 1;
    }
    log.warn(result.message);
  }
  if (!confirmed) {
    log.error('Too many wrong attempts. Run the pair flow again.');
    await stopBot();
    return 1;
  }

  log.info('Bot is running. Press Ctrl+C to stop.');

  // Hand off the running bot. SIGINT shuts it down cleanly and exits.
  const shutdown = async (): Promise<void> => {
    await stopBot();
    await session.close('SIGINT').catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await handle.running;
  return 0;
}
