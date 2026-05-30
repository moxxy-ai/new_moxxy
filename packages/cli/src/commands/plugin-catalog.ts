import { isCancel, select } from '@clack/prompts';
import { discoverPlugins, silentLogger } from '@moxxy/core';
import { isPureUiPluginManifest } from '@moxxy/sdk';
import {
  installPluginPackage,
  userPluginsDir,
  type InstallPluginPackageOptions,
  type InstallPluginPackageResult,
} from '@moxxy/plugin-plugins-admin';
import * as path from 'node:path';
import type { ParsedArgv } from '../argv.js';
import { colors } from '../colors.js';

export interface PluginCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly packageName: string;
  readonly installSpec: string;
  readonly startCommand: string;
  readonly defaultPort?: number;
}

export interface PluginCatalogOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export const DEFAULT_PLUGIN_CATALOG: ReadonlyArray<PluginCatalogEntry> = [
  {
    id: 'virtual-office',
    label: 'Virtual Office',
    description: 'Pixel-art UI for running Moxxy with an office view and session picker.',
    packageName: '@moxxy/virtual-office-plugin',
    installSpec: 'github:moxxy-ai/virtual-office-plugin#main',
    startCommand: 'moxxy marketplace open virtual-office --tui',
    defaultPort: 17901,
  },
];

export interface RunPluginCatalogDeps {
  readonly catalog?: ReadonlyArray<PluginCatalogEntry>;
  readonly loadInstalledPackageNames?: () => Promise<ReadonlySet<string>>;
  readonly selectPlugin?: (input: {
    readonly message: string;
    readonly options: ReadonlyArray<PluginCatalogOption>;
  }) => Promise<string | symbol>;
  readonly installPluginPackage?: (
    opts: InstallPluginPackageOptions,
  ) => Promise<InstallPluginPackageResult>;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

export function buildCatalogOptions(
  catalog: ReadonlyArray<PluginCatalogEntry>,
  installedPackageNames: ReadonlySet<string>,
): PluginCatalogOption[] {
  return catalog.map((entry) => ({
    value: entry.id,
    label: entry.label,
    hint: installedPackageNames.has(entry.packageName)
      ? `installed · ${entry.startCommand}`
      : `install from ${entry.installSpec}`,
  }));
}

export async function runPluginCatalogCommand(
  _argv: ParsedArgv,
  deps: RunPluginCatalogDeps = {},
): Promise<number> {
  const catalog = deps.catalog ?? DEFAULT_PLUGIN_CATALOG;
  const loadInstalledPackageNames = deps.loadInstalledPackageNames ?? loadInstalledUiPackageNames;
  const selectPlugin = deps.selectPlugin ?? defaultSelectPlugin;
  const install = deps.installPluginPackage ?? installPluginPackage;
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));

  if (catalog.length === 0) {
    writeOut(colors.dim('(no installable plugins in the catalog)\n'));
    return 0;
  }

  const installed = await loadInstalledPackageNames();
  const chosen = await selectPlugin({
    message: 'Pick a plugin to install or open',
    options: buildCatalogOptions(catalog, installed),
  });
  if (isCancel(chosen) || typeof chosen !== 'string') return 0;

  const entry = catalog.find((candidate) => candidate.id === chosen);
  if (!entry) {
    writeErr(colors.red(`error: unknown plugin catalog entry: ${chosen}`) + '\n');
    return 1;
  }

  if (installed.has(entry.packageName)) {
    writeOut(
      `${colors.bold(entry.packageName)} ${colors.dim('is already installed.')}\n` +
        `${colors.dim('Start it with')} ${colors.bold(entry.startCommand)}\n`,
    );
    return 0;
  }

  try {
    const result = await install({ packageName: entry.installSpec });
    writeOut(
      `${colors.bold('installed')}  ${colors.bold(entry.packageName)}\n` +
        `${colors.dim('source: ' + result.installed)}\n` +
        `${colors.dim('plugins dir: ' + result.dir)}\n` +
        `${colors.dim('Start it with')} ${colors.bold(entry.startCommand)}\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeErr(colors.red('error: ') + msg + '\n');
    return 1;
  }
}

export async function loadInstalledUiPackageNames(): Promise<ReadonlySet<string>> {
  const pluginsDir = userPluginsDir();
  const manifests = await discoverPlugins({
    cwd: process.cwd(),
    logger: silentLogger,
    extraPaths: [pluginsDir, path.join(pluginsDir, 'node_modules')],
  });
  return new Set(manifests.filter(isPureUiPluginManifest).map((manifest) => manifest.packageName));
}

async function defaultSelectPlugin(input: {
  readonly message: string;
  readonly options: ReadonlyArray<PluginCatalogOption>;
}): Promise<string | symbol> {
  return await select<string>({
    message: input.message,
    options: input.options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
  });
}
