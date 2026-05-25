import type { ParsedArgv } from '../argv.js';
import { bootSession, helpRequested } from '../argv-helpers.js';
import { discoverPlugins } from '@moxxy/core';
import { isPureUiPluginManifest, type ResolvedPluginManifest } from '@moxxy/sdk';
import { userPluginsDir } from '@moxxy/plugin-plugins-admin';
import { printError } from '../errors.js';
import { runPluginCatalogCommand } from './plugin-catalog.js';
import { runPluginInstallCommand } from './plugin-install.js';
import { runPluginNewCommand } from './plugin-new.js';
import { runPluginStartCommand } from './plugin-start.js';
import { colors } from '../colors.js';
import { formatHelp } from './help-format.js';
import * as path from 'node:path';

const HELP = formatHelp({
  title: 'moxxy plugins',
  tagline: 'manage the plugin host',
  sections: [
    {
      title: 'COMMANDS',
      rows: [
        ['(no subcommand)', 'browse installable plugins in an interactive picker'],
        ['list', 'list loaded plugins'],
        ['install <package-or-path>', 'install a plugin into ~/.moxxy/plugins'],
        ['start <package-or-path>', 'start a UI plugin in the foreground'],
        ['reload', 'rescan discovery roots and hot-reload'],
        ['new <name> [--here]', 'scaffold a new user-scope plugin'],
      ],
    },
  ],
});

export interface FormatPluginsListInput {
  readonly runtime: ReadonlyArray<{ name: string; version: string; loaded: boolean }>;
  readonly ui: ReadonlyArray<ResolvedPluginManifest>;
}

export function formatPluginsList(input: FormatPluginsListInput): string {
  const names = [...input.runtime.map((p) => p.name), ...input.ui.map((p) => p.packageName)];
  const nameCol = Math.max(8, ...names.map((name) => name.length));
  const out: string[] = [];
  for (const p of input.runtime) {
    out.push(`${colors.bold(p.name.padEnd(nameCol))}  ${colors.dim('@' + p.version)}`);
  }
  for (const p of input.ui) {
    const port = p.port ? `ui:${p.port}` : 'ui';
    out.push(
      `${colors.bold(p.packageName.padEnd(nameCol))}  ${colors.dim('@' + p.packageVersion)}  ` +
        `${colors.dim(port)}  ${colors.dim(p.packagePath)}`,
    );
  }
  return out.length > 0 ? out.join('\n') + '\n' : colors.dim('(no plugins found)\n');
}

export interface RunPluginsCommandDeps {
  readonly isInteractive?: () => boolean;
  readonly runCatalog?: (argv: ParsedArgv) => Promise<number>;
}

export async function runPluginsCommand(
  argv: ParsedArgv,
  deps: RunPluginsCommandDeps = {},
): Promise<number> {
  if (argv.positional[0] === 'help' || helpRequested(argv)) {
    process.stdout.write(HELP);
    return 0;
  }

  const sub = argv.positional[0];
  if (!sub && (deps.isInteractive ?? isInteractiveTerminal)()) {
    return await (deps.runCatalog ?? runPluginCatalogCommand)(argv);
  }

  const requestedSub = sub ?? 'list';
  if (requestedSub === 'new') {
    return await runPluginNewCommand(argv);
  }
  if (requestedSub === 'install') {
    return await runPluginInstallCommand(argv);
  }
  if (requestedSub === 'start') {
    return await runPluginStartCommand(argv);
  }
  const session = await bootSession(argv, {
    skipKeyPrompt: true,
    tolerateNoProvider: true,
    skipProviderActivation: true,
  });
  if (requestedSub === 'list') {
    const pluginsDir = userPluginsDir();
    const manifests = await discoverPlugins({
      cwd: process.cwd(),
      logger: session.logger,
      extraPaths: [pluginsDir, path.join(pluginsDir, 'node_modules')],
    });
    process.stdout.write(
      formatPluginsList({
        runtime: session.pluginHost.list(),
        ui: manifests.filter(isPureUiPluginManifest),
      }),
    );
    return 0;
  }
  if (requestedSub === 'reload') {
    await session.pluginHost.reload();
    process.stdout.write(colors.dim('reload complete') + '\n');
    return 0;
  }
  printError(`unknown 'plugins' subcommand: ${requestedSub}\n${HELP}`);
  return 2;
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
