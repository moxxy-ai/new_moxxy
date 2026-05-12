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
import { runDoctorCommand } from './commands/doctor.js';
import { setupSessionWithConfig } from './setup.js';
import { renderLogo } from './logo.js';
import { colors } from './colors.js';

type CommandHandler = (argv: ParsedArgv) => Promise<number>;

const HELP = `usage:
  moxxy init                         interactive first-time setup (provider keys → vault)
  moxxy                              start interactive TUI (default channel)
  moxxy tui                          start the Ink TUI channel
  moxxy <channel-name>               start any registered channel by name
                                       (e.g. moxxy slack — once such a channel is installed)
  moxxy -p "..."                     one-shot prompt to stdout
  moxxy --prompt "..." [flags]       same; flags: --allow-tools, --allow-all,
                                                  --output-format text|json|stream-json,
                                                  --model <model-id>
  moxxy channels                     list registered channels + their subcommands
  moxxy channels <name>              start a channel by name (same as 'moxxy <name>')
  moxxy channels <name> <sub> [...]  invoke a channel-defined subcommand
                                     (e.g. 'moxxy channels telegram pair|unpair|status')
  moxxy skills list|new <name>       manage skill files
  moxxy plugins list|reload          manage plugin host
  moxxy perms list|allow|deny|remove|clear|path  view/edit the permission policy
  moxxy memory list|audit|show|revert|prune-stale|path  curate long-term memory
  moxxy mcp list|enable|disable|remove|path  manage Model Context Protocol servers
  moxxy doctor [--check-keys]        diagnose config, vault, providers, channels, memory
  moxxy --help                       this help
  moxxy --version                    print version

provider API keys are resolved in order:  vault → env var → interactive prompt
(the prompt only runs in a TTY; prompted values are saved back to the vault).

env:
  ANTHROPIC_API_KEY                  default Anthropic provider key
  OPENAI_API_KEY                     OpenAI provider key (and openai embeddings)
  MOXXY_FIXTURES=record|replay       provider fixture mode (used by tests)
  MOXXY_VAULT_PASSPHRASE             headless vault passphrase (alt to keychain)
  MOXXY_TELEGRAM_TOKEN               override the vault-stored Telegram token
`;

// Single source of truth: a command name → handler dispatch table. Adding a
// new built-in subcommand here is enough; there's no separate KNOWN_COMMANDS
// set that can drift out of sync.
const COMMANDS: Record<string, CommandHandler> = {
  help: async () => {
    process.stdout.write(renderLogo() + HELP);
    return 0;
  },
  version: async () => {
    process.stdout.write(renderLogo() + 'moxxy 0.0.0\n');
    return 0;
  },
  init: runInitCommand,
  perms: runPermsCommand,
  memory: runMemoryCommand,
  mcp: runMcpCommand,
  doctor: runDoctorCommand,
  prompt: runPromptCommand,
  tui: runTuiCommand,
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
    colors.red(`unknown command: ${argv.command}`) + '\n' + HELP,
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
