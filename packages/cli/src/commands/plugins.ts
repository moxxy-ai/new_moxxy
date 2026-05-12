import type { ParsedArgv } from '../argv.js';
import { bootSession, helpRequested } from '../argv-helpers.js';
import { printError } from '../errors.js';
import { runPluginNewCommand } from './plugin-new.js';
import { colors } from '../colors.js';

const HELP = `moxxy plugins — manage the plugin host

  moxxy plugins list                 list loaded plugins
  moxxy plugins reload               rescan discovery roots and hot-reload
  moxxy plugins new <name> [--here]  scaffold a new user-scope plugin
`;

export async function runPluginsCommand(argv: ParsedArgv): Promise<number> {
  const sub = argv.positional[0] ?? 'list';
  if (sub === 'new') {
    return await runPluginNewCommand(argv);
  }
  if (sub === 'help' || helpRequested(argv)) {
    process.stdout.write(HELP);
    return 0;
  }
  const session = await bootSession(argv, { skipKeyPrompt: true, tolerateNoProvider: true });
  if (sub === 'list') {
    for (const p of session.pluginHost.list()) {
      process.stdout.write(`${colors.bold(p.name)}${colors.dim('@' + p.version)}\n`);
    }
    return 0;
  }
  if (sub === 'reload') {
    await session.pluginHost.reload();
    process.stdout.write(colors.green('reload complete') + '\n');
    return 0;
  }
  printError(`unknown 'plugins' subcommand: ${sub}\n${HELP}`);
  return 2;
}
