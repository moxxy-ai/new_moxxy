#!/usr/bin/env node
import { parseArgv, type ParsedArgv } from './argv.js';
import { runPromptCommand } from './commands/prompt.js';
import { runTuiCommand } from './commands/tui.js';
import { runSkillsCommand } from './commands/skills.js';
import { runPluginsCommand } from './commands/plugins.js';
import { runChannelsCommand } from './commands/channels.js';
import { runChannelByName } from './commands/run-channel.js';
import { runInitCommand } from './commands/init.js';
import { runPermsCommand } from './commands/perms.js';
import { runMemoryCommand } from './commands/memory.js';
import { runMcpCommand } from './commands/mcp.js';
import { runScheduleCommand } from './commands/schedule.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runLoginCommand } from './commands/login.js';
import { runResumeCommand } from './commands/resume.js';
import { runSessionsCommand } from './commands/sessions.js';
import { setupSessionWithConfig } from './setup.js';
import { renderLogo } from './logo.js';
import { colors } from './colors.js';
import { cliVersion } from './version.js';
import { pickSlogan } from '@moxxy/plugin-cli';

type CommandHandler = (argv: ParsedArgv) => Promise<number>;

/**
 * Help is rendered as a vertical-stepper layout that matches the look of the
 * `moxxy init` clack-based wizard: a `┌` corner at the top, a `│` rail down
 * the left of every line, and a `└` corner at the bottom. Sections are
 * separated by an empty `│` line and labeled with a bullet (`◇`).
 */
const SECTIONS: ReadonlyArray<{ readonly title: string; readonly rows: ReadonlyArray<readonly [string, string]> }> = [
  {
    title: 'USAGE',
    rows: [
      ['moxxy', 'start the interactive TUI (default channel)'],
      ['moxxy <channel>', 'start a registered channel by name (e.g. `moxxy slack`)'],
      ['moxxy -p "..."', 'one-shot prompt to stdout'],
      ['moxxy <command> ...', 'run a built-in subcommand (see below)'],
    ],
  },
  {
    title: 'SETUP',
    rows: [
      ['init', 'interactive first-time setup (provider keys → vault)'],
      ['login openai-codex', 'OAuth sign-in for ChatGPT Pro/Plus (Codex backend)'],
      ['login status|logout', 'inspect / remove stored OAuth credentials'],
      ['doctor [--check-keys]', 'diagnose config, vault, providers, channels, memory'],
    ],
  },
  {
    title: 'RUN',
    rows: [
      ['tui', 'start the Ink TUI channel'],
      ['resume [-s <id>|<id>]', 'resume a persisted session (interactive picker if no id)'],
      ['channels', 'list registered channels + their subcommands'],
      ['channels <name>', 'start a channel by name (same as `moxxy <name>`)'],
      ['channels <name> <sub>', 'invoke a channel-defined subcommand (e.g. telegram pair)'],
    ],
  },
  {
    title: 'MANAGE',
    rows: [
      ['sessions list', 'list persisted sessions, most-recent first'],
      ['skills list|new <name>', 'manage skill files'],
      ['plugins list|reload', 'manage plugin host'],
      ['perms list|allow|deny|remove|clear|path', 'view/edit the permission policy'],
      ['memory list|audit|show|revert|prune-stale|path', 'curate long-term memory'],
      ['mcp list|enable|disable|remove|path', 'manage Model Context Protocol servers'],
      ['schedule list|add|remove|run|daemon', 'manage time-driven prompts (cron/heartbeat)'],
    ],
  },
  {
    title: 'FLAGS',
    rows: [
      ['--prompt, -p "..."', 'one-shot input (alias of the positional `prompt` form)'],
      ['--model <id>', 'override the default model for this invocation'],
      ['--output-format <fmt>', 'text | json | stream-json (one-shot output mode)'],
      ['--allow-tools, --allow-all', 'permission shortcuts for non-interactive runs'],
      ['--help, --version', 'this help / print version'],
    ],
  },
  {
    title: 'ENV',
    rows: [
      ['ANTHROPIC_API_KEY', 'default Anthropic provider key'],
      ['OPENAI_API_KEY', 'OpenAI provider key (and openai embeddings)'],
      ['MOXXY_FIXTURES', 'record | replay — provider fixture mode (used by tests)'],
      ['MOXXY_VAULT_PASSPHRASE', 'headless vault passphrase (alt to keychain)'],
      ['MOXXY_TELEGRAM_TOKEN', 'override the vault-stored Telegram token'],
    ],
  },
];

const STEP_BULLET = '◇';
const RAIL = '│';
const RAIL_TOP = '┌';
const RAIL_BOTTOM = '└';

function renderHelp(): string {
  // Compute a single max-column width across every section so commands and
  // descriptions line up no matter which header you scan to.
  const colWidth = Math.max(
    ...SECTIONS.flatMap((s) => s.rows.map(([cmd]) => cmd.length)),
  );

  const rail = colors.dim(RAIL);
  const bullet = colors.dim(STEP_BULLET);
  const version = cliVersion();
  // Box header carries the slogan (plus version) — replaces the older
  // "moxxy v0.0.0 — block-based agentic loop" line.
  const header =
    colors.dim(colors.italic(pickSlogan())) +
    (version ? colors.dim(`  ·  v${version}`) : '');

  const out: string[] = [];
  out.push(`${colors.dim(RAIL_TOP)}  ${header}`);
  out.push(rail);

  SECTIONS.forEach((section, i) => {
    out.push(`${bullet}  ${colors.bold(section.title)}`);
    for (const [cmd, desc] of section.rows) {
      const padded = cmd.padEnd(colWidth, ' ');
      out.push(`${rail}    ${colors.green(padded)}  ${colors.dim(desc)}`);
    }
    if (i < SECTIONS.length - 1) out.push(rail);
  });

  out.push(rail);
  out.push(
    `${rail}  ${colors.bold('Keys')}  ${colors.dim(
      'provider keys resolve in order: vault → env var → interactive prompt',
    )}`,
  );
  out.push(`${rail}        ${colors.dim('(TTY only; prompted values are saved back to the vault).')}`);
  out.push(rail);
  out.push(
    `${colors.dim(RAIL_BOTTOM)}  ${colors.dim('Run')} ${colors.cyan('moxxy init')} ${colors.dim('to get started.')}`,
  );

  return out.join('\n') + '\n';
}

// Single source of truth: a command name → handler dispatch table. Adding a
// new built-in subcommand here is enough; there's no separate KNOWN_COMMANDS
// set that can drift out of sync.
const COMMANDS: Record<string, CommandHandler> = {
  help: async () => {
    process.stdout.write(renderLogo() + renderHelp());
    return 0;
  },
  version: async () => {
    const v = cliVersion() ?? '0.0.0';
    process.stdout.write(renderLogo() + `moxxy ${v}\n`);
    return 0;
  },
  init: runInitCommand,
  login: runLoginCommand,
  perms: runPermsCommand,
  memory: runMemoryCommand,
  mcp: runMcpCommand,
  schedule: runScheduleCommand,
  doctor: runDoctorCommand,
  prompt: runPromptCommand,
  tui: runTuiCommand,
  resume: runResumeCommand,
  sessions: runSessionsCommand,
  skills: runSkillsCommand,
  plugins: runPluginsCommand,
  channels: runChannelsCommand,
};

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));

  const handler = COMMANDS[argv.command];
  if (handler) return handler(argv);

  // Not a built-in. See if it names a registered channel — skip the
  // API-key prompt so a typo doesn't accidentally boot the provider.
  try {
    const { session } = await setupSessionWithConfig({
      cwd: process.cwd(),
      skipKeyPrompt: true,
      tolerateNoProvider: true,
    });
    if (session.channels.has(argv.command)) {
      return await runChannelByName(argv.command, argv);
    }
  } catch {
    // setup failed for an unrelated reason — fall through to "unknown command".
  }

  process.stderr.write(
    colors.red(`unknown command: ${argv.command}`) + '\n' + renderHelp(),
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Surface specific user-actionable errors without the scary "fatal:" prefix.
    // VaultPassphraseError already contains a recovery hint in its message.
    if (err && (err as Error).name === 'VaultPassphraseError') {
      process.stderr.write(colors.red((err as Error).message) + '\n');
      process.exit(1);
    }
    process.stderr.write(
      colors.red('fatal: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    process.exit(1);
  },
);
