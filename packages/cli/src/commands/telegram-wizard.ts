import {
  cancel,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  select,
} from '@clack/prompts';
import {
  TELEGRAM_AUTHORIZED_CHAT_KEY,
  TELEGRAM_TOKEN_KEY,
  TELEGRAM_TOKEN_RE,
} from '@moxxy/plugin-telegram';
import type { VaultStore } from '@moxxy/plugin-vault';
import { bootSessionWithConfig } from '../argv-helpers.js';
import type { ParsedArgv } from '../argv.js';
import { colors } from '../colors.js';
import { startRegisteredChannel } from './start-registered-channel.js';
import { actionPair } from './telegram/pair.js';

interface State {
  readonly hasToken: boolean;
  /** "<prefix>…<suffix>" of the bot id for display. null when none. */
  readonly tokenPreview: string | null;
  readonly authorizedChatId: number | null;
}

type Action = 'set-token' | 'pair' | 'unpair' | 'start' | 'quit';

/**
 * Interactive Telegram setup menu.
 *
 * Invoked by `runChannelByName` when the user runs `moxxy telegram`
 * or `moxxy channels telegram` with no subcommand in a TTY. Headless
 * invocations (or `--start`) bypass it and start the bot directly,
 * preserving the cron / systemd usage path.
 *
 * Menu offers actions appropriate to the current state:
 *   - no token            → "Set bot token" + "Quit"
 *   - token, not paired   → "Pair this terminal" + "Change token" + "Quit"
 *   - token + paired      → "Start bot" + "Unpair" + "Change token" + "Quit"
 *
 * Pairing is driven by the wizard end-to-end: the wizard opens a pair
 * window, the bot waits for /start, on /start it DMs a 6-digit code to
 * the user, and the user pastes the code back into this wizard.
 */
export async function runTelegramWizard(argv: ParsedArgv): Promise<number> {
  const { vault } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    tolerateNoProvider: true,
    skipProviderActivation: true,
  });

  intro(colors.bold('moxxy telegram setup'));

  // Short-circuit if the user invoked `moxxy channels telegram pair` —
  // skip the menu, jump straight to the pair flow. Token-less state is
  // surfaced with a clear error rather than the menu fallback.
  if (argv.flags['pair'] === true) {
    const state = await readState(vault);
    if (!state.hasToken) {
      log.error('No bot token configured. Run `moxxy telegram` and pick "Set the bot token" first.');
      return 1;
    }
    return await actionPair(argv);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const state = await readState(vault);
    printStatus(state);
    const action = await pickAction(state);
    if (action === null) {
      cancel('cancelled.');
      return 0;
    }
    if (action === 'quit') {
      outro(colors.dim('done.'));
      return 0;
    }
    if (action === 'set-token') {
      await actionSetToken(vault);
      continue;
    }
    if (action === 'pair') {
      return await actionPair(argv);
    }
    if (action === 'unpair') {
      await vault.delete(TELEGRAM_AUTHORIZED_CHAT_KEY);
      log.success('Unpaired. The next /start from any chat will begin a fresh pairing window.');
      continue;
    }
    if (action === 'start') {
      log.info('Starting the bot. Press Ctrl+C to stop.');
      outro(colors.dim('handing off to bot…'));
      return startRegisteredChannel('telegram', {
        ...argv,
        flags: { ...argv.flags, __skipWizard: true },
      });
    }
  }
}

async function readState(vault: VaultStore): Promise<State> {
  // env beats vault for token (matches the channel's own isAvailable
  // precedence) so the wizard reflects what the bot would actually see
  // at start time.
  const envToken = process.env.MOXXY_TELEGRAM_TOKEN;
  const vaultToken = envToken ?? (await vault.get(TELEGRAM_TOKEN_KEY));
  const authorized = await vault.get(TELEGRAM_AUTHORIZED_CHAT_KEY);
  return {
    hasToken: !!vaultToken,
    tokenPreview: vaultToken ? maskToken(vaultToken) : null,
    authorizedChatId: authorized ? Number(authorized) : null,
  };
}

function maskToken(token: string): string {
  const id = token.split(':')[0] ?? '';
  return id.length > 4 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}

function printStatus(state: State): void {
  const lines: string[] = [];
  lines.push(
    `Token        ${state.hasToken ? colors.bold(state.tokenPreview ?? 'set') : colors.dim('not set')}`,
  );
  lines.push(
    `Paired chat  ${state.authorizedChatId != null ? colors.bold(String(state.authorizedChatId)) : colors.dim('none')}`,
  );
  note(lines.join('\n'), 'status');
}

async function pickAction(state: State): Promise<Action | null> {
  const options: Array<{ value: Action; label: string; hint?: string }> = [];
  if (state.hasToken && state.authorizedChatId != null) {
    options.push({
      value: 'start',
      label: 'Start the bot',
      hint: 'runs forever — Ctrl+C to stop',
    });
    options.push({
      value: 'unpair',
      label: 'Unpair this chat',
      hint: 'next /start begins a fresh pairing window',
    });
  } else if (state.hasToken) {
    options.push({
      value: 'pair',
      label: 'Pair a Telegram chat',
      hint: 'bot sends you a code in chat; paste it here',
    });
  }
  options.push({
    value: 'set-token',
    label: state.hasToken ? 'Change the bot token' : 'Set the bot token',
    hint: state.hasToken ? undefined : 'get one from @BotFather on Telegram',
  });
  options.push({ value: 'quit', label: 'Quit' });

  const choice = await select<Action>({ message: 'What do you want to do?', options });
  if (isCancel(choice)) return null;
  return choice as Action;
}

async function actionSetToken(vault: VaultStore): Promise<boolean> {
  note(
    'Open https://t.me/BotFather, run /newbot (or /token for an existing bot), copy the\n' +
      'token it returns (looks like 1234567890:ABCdef…), and paste it below. It goes\n' +
      "straight into the moxxy vault under '" +
      TELEGRAM_TOKEN_KEY +
      "' — no env var needed.",
    'get a bot token',
  );
  const token = await password({
    message: 'Paste the Telegram bot token',
    mask: '•',
    validate: (v) => {
      if (!v || v.trim().length === 0) return 'required';
      if (!TELEGRAM_TOKEN_RE.test(v.trim())) {
        return 'doesn\'t look like a Telegram token — expected "<digits>:<22+ url-safe chars>"';
      }
      return undefined;
    },
  });
  if (isCancel(token)) return false;
  await vault.set(TELEGRAM_TOKEN_KEY, String(token).trim(), ['telegram']);
  log.success('Token stored in vault.');
  return true;
}
