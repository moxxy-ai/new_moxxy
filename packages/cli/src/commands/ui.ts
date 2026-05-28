import * as path from 'node:path';
import { discoverPlugins, silentLogger } from '@moxxy/core';
import { isUiPluginManifest, type ResolvedPluginManifest } from '@moxxy/sdk';
import { userPluginsDir } from '@moxxy/plugin-plugins-admin';
import type { ParsedArgv } from '../argv.js';
import { helpRequested } from '../argv-helpers.js';
import { colors } from '../colors.js';
import { printError } from '../errors.js';
import { runPluginStartCommand } from './plugin-start.js';

const HELP = `moxxy ui — manage and launch UI plugins

  moxxy ui                            list installed UI plugins
  moxxy ui list                       same as above
  moxxy ui open <plugin>              start a UI plugin in the foreground
  moxxy ui open <plugin> --port 17901 --api-port 3737 --open
  moxxy ui open <plugin> --tui
  moxxy ui open <plugin> --session <id> | --new-session
  moxxy ui open <plugin> -- --theme dark --debug   forward custom args

Anything after the first \`--\` is forwarded to the UI plugin's child
process as its own argv.

A UI plugin is a package whose package.json declares
\`moxxy.plugin.kind = "ui"\` and a required \`moxxy.plugin.port\`. Install
candidates via \`moxxy marketplace add <id-or-spec>\`.
`;

export async function runUiCommand(argv: ParsedArgv): Promise<number> {
  if (helpRequested(argv) || argv.positional[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const sub = argv.positional[0];

  if (!sub || sub === 'list') {
    return await runUiList();
  }

  if (sub === 'open') {
    if (!argv.positional[1]) {
      printError('moxxy ui open requires a UI plugin id, package name, or path.');
      return 2;
    }
    // runPluginStartCommand reads positional[1] as the target — leave the
    // argv shape it expects (positional: ['open', '<name>', …]) intact.
    return await runPluginStartCommand(argv);
  }

  printError(`unknown 'ui' subcommand: ${sub}\n${HELP}`);
  return 2;
}

async function runUiList(): Promise<number> {
  const pluginsDir = userPluginsDir();
  const manifests = await discoverPlugins({
    cwd: process.cwd(),
    logger: silentLogger,
    extraPaths: [pluginsDir, path.join(pluginsDir, 'node_modules')],
  });
  const uiManifests = manifests.filter(isUiPluginManifest);
  process.stdout.write(formatUiList(uiManifests));
  return 0;
}

export function formatUiList(manifests: ReadonlyArray<ResolvedPluginManifest>): string {
  if (manifests.length === 0) {
    return colors.dim('(no UI plugins installed — try `moxxy marketplace`)\n');
  }
  const nameCol = Math.max(...manifests.map((m) => m.packageName.length));
  const lines = manifests.map((manifest) => {
    const port = manifest.port ? `:${manifest.port}` : '';
    const title = manifest.title ? colors.dim(`  ${manifest.title}`) : '';
    return `${colors.bold(manifest.packageName.padEnd(nameCol))}  ${colors.dim('ui' + port)}${title}`;
  });
  return lines.join('\n') + '\n';
}
