import { isCancel, select, spinner } from '@clack/prompts';
import { discoverPlugins, silentLogger } from '@moxxy/core';
import {
  installPluginPackage,
  removePluginPackage,
  userPluginsDir,
  type InstallPluginPackageOptions,
  type InstallPluginPackageResult,
  type RemovePluginPackageOptions,
  type RemovePluginPackageResult,
} from '@moxxy/plugin-plugins-admin';
import * as path from 'node:path';
import {
  buildInstallSpec,
  buildMarketplaceActionOptions,
  buildMarketplaceOptions,
  DEFAULT_MARKETPLACE_CATALOG,
  formatMarketplaceStatus,
  resolveMarketplaceEntry,
  resolveMarketplacePackageName,
  type MarketplaceAction,
  type MarketplaceActionOption,
  type MarketplaceCatalogEntry,
  type MarketplaceOption,
} from './catalog.js';
import {
  clearPluginState,
  isPluginDisabled,
  loadDisabledPackageNames,
  setPluginEnabled,
} from './config-state.js';

export interface MarketplaceArgv {
  readonly command: string;
  readonly positional: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, unknown>>;
  /** Raw argv after the first `--` separator. Forwarded as-is to UI plugin children. */
  readonly passthrough?: ReadonlyArray<string>;
}

export interface MarketplaceSpinner {
  start(message?: string): void;
  stop(message?: string): void;
  error(message?: string): void;
}

export interface RunMarketplaceCommandDeps {
  readonly catalog?: ReadonlyArray<MarketplaceCatalogEntry>;
  readonly loadInstalledPackageNames?: () => Promise<ReadonlySet<string>>;
  readonly loadDisabledPackageNames?: () => Promise<ReadonlySet<string>>;
  readonly installPluginPackage?: (
    opts: InstallPluginPackageOptions,
  ) => Promise<InstallPluginPackageResult>;
  readonly removePluginPackage?: (
    opts: RemovePluginPackageOptions,
  ) => Promise<RemovePluginPackageResult>;
  readonly setPluginEnabled?: (packageName: string, enabled: boolean) => Promise<void>;
  readonly clearPluginState?: (packageName: string) => Promise<void>;
  readonly isPluginDisabled?: (packageName: string) => Promise<boolean>;
  readonly startUiPlugin?: (argv: MarketplaceArgv) => Promise<number>;
  readonly createSpinner?: () => MarketplaceSpinner;
  readonly selectPlugin?: (input: {
    readonly message: string;
    readonly options: ReadonlyArray<MarketplaceOption>;
  }) => Promise<string | symbol>;
  readonly selectAction?: (input: {
    readonly message: string;
    readonly options: ReadonlyArray<MarketplaceActionOption>;
  }) => Promise<MarketplaceAction | symbol>;
  readonly isInteractive?: () => boolean;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

export function buildMarketplaceOpenArgv(
  argv: MarketplaceArgv,
  packageName: string,
  openFlags: Readonly<Record<string, string | boolean>> = {},
): MarketplaceArgv {
  return {
    command: 'marketplace',
    flags: { ...openFlags, ...argv.flags },
    positional: ['open', packageName],
    ...(argv.passthrough ? { passthrough: [...argv.passthrough] } : {}),
  };
}

export async function runMarketplaceCommand(
  argv: MarketplaceArgv,
  deps: RunMarketplaceCommandDeps = {},
): Promise<number> {
  const catalog = deps.catalog ?? DEFAULT_MARKETPLACE_CATALOG;
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  const subcommand = argv.positional[0];

  if (hasHelpFlag(argv)) {
    writeOut(renderMarketplaceHelp());
    return 0;
  }

  if (!subcommand) {
    const interactive = deps.isInteractive ?? (() => Boolean(process.stdout.isTTY));
    if (interactive()) return runMarketplacePicker(argv, deps);
    return runMarketplaceList(catalog, deps);
  }

  switch (subcommand) {
    case 'list':
      return runMarketplaceList(catalog, deps);
    case 'add':
      return runMarketplaceAdd(argv, catalog, deps);
    case 'remove':
      return runMarketplaceRemove(argv, catalog, deps);
    case 'enable':
      return runMarketplaceEnable(argv, catalog, deps, true);
    case 'disable':
      return runMarketplaceEnable(argv, catalog, deps, false);
    case 'open':
      return runMarketplaceOpen(argv, catalog, deps);
    default:
      writeErr(`error: unknown marketplace command: ${subcommand}\n${renderMarketplaceHelp()}`);
      return 2;
  }
}

export async function loadInstalledPackageNames(): Promise<ReadonlySet<string>> {
  const pluginsDir = userPluginsDir();
  const manifests = await discoverPlugins({
    cwd: process.cwd(),
    logger: silentLogger,
    extraPaths: [pluginsDir, path.join(pluginsDir, 'node_modules')],
  });
  return new Set(manifests.map((manifest) => manifest.packageName));
}

export function renderMarketplaceHelp(): string {
  return [
    'moxxy marketplace',
    '',
    'Commands:',
    '  marketplace                    open the interactive plugin picker',
    '  marketplace list               list installable plugins and status',
    '  marketplace add <plugin>        install from catalog, npm, GitHub, or path',
    '  marketplace remove <plugin>     uninstall a plugin package',
    '  marketplace enable <plugin>     enable an installed plugin',
    '  marketplace disable <plugin>    disable an installed plugin',
    '  marketplace open <plugin>       open a UI plugin',
    '',
  ].join('\n');
}

async function runMarketplacePicker(
  argv: MarketplaceArgv,
  deps: RunMarketplaceCommandDeps,
): Promise<number> {
  const catalog = deps.catalog ?? DEFAULT_MARKETPLACE_CATALOG;
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  const installed = await (deps.loadInstalledPackageNames ?? loadInstalledPackageNames)();
  const disabled = await (deps.loadDisabledPackageNames ?? loadDisabledPackageNames)();
  const selectPlugin = deps.selectPlugin ?? defaultSelectPlugin;
  const chosen = await selectPlugin({
    message: 'Pick a plugin to install or open',
    options: buildMarketplaceOptions({
      catalog,
      installedPackageNames: installed,
      disabledPackageNames: disabled,
    }),
  });

  if (isCancel(chosen) || typeof chosen !== 'string') return 0;
  const entry = resolveMarketplaceEntry(chosen, catalog);
  if (!entry) {
    writeErr(`error: unknown marketplace entry: ${chosen}\n`);
    return 1;
  }

  const selectAction = deps.selectAction ?? defaultSelectAction;
  const action = await selectAction({
    message: `Manage ${entry.label}`,
    options: buildMarketplaceActionOptions({
      entry,
      installedPackageNames: installed,
      disabledPackageNames: disabled,
    }),
  });

  if (isCancel(action) || action === 'back') return 0;

  switch (action) {
    case 'install':
      return runMarketplaceAdd({ ...argv, positional: ['add', entry.id] }, catalog, deps);
    case 'open':
      return runMarketplaceOpen({ ...argv, positional: ['open', entry.id] }, catalog, deps);
    case 'enable':
      return runMarketplaceEnable({ ...argv, positional: ['enable', entry.id] }, catalog, deps, true);
    case 'disable':
      return runMarketplaceEnable({ ...argv, positional: ['disable', entry.id] }, catalog, deps, false);
    case 'remove':
      return runMarketplaceRemove({ ...argv, positional: ['remove', entry.id] }, catalog, deps);
  }
}

async function runMarketplaceList(
  catalog: ReadonlyArray<MarketplaceCatalogEntry>,
  deps: RunMarketplaceCommandDeps,
): Promise<number> {
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const installed = await (deps.loadInstalledPackageNames ?? loadInstalledPackageNames)();
  const disabled = await (deps.loadDisabledPackageNames ?? loadDisabledPackageNames)();
  const rows = catalog.map((entry) => {
    const status = formatMarketplaceStatus(entry, installed, disabled);
    return `${entry.id.padEnd(16)} ${status}`;
  });
  writeOut(rows.length > 0 ? rows.join('\n') + '\n' : '(marketplace catalog is empty)\n');
  return 0;
}

async function runMarketplaceAdd(
  argv: MarketplaceArgv,
  catalog: ReadonlyArray<MarketplaceCatalogEntry>,
  deps: RunMarketplaceCommandDeps,
): Promise<number> {
  const target = argv.positional[1];
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  if (!target) {
    writeErr('error: marketplace add requires a plugin id, package, GitHub spec, or path\n');
    return 2;
  }

  const spec = buildInstallSpec({
    target,
    version: stringFlag(argv, 'version'),
    ref: stringFlag(argv, 'ref'),
    catalog,
  });
  const entry = resolveMarketplaceEntry(target, catalog);
  const label = entry?.label ?? target;

  try {
    const install = deps.installPluginPackage ?? installPluginPackage;
    const result = await withMarketplaceProgress(
      deps,
      {
        start: `Installing ${label}...`,
        stop: `Installed ${label}`,
        error: 'Install failed',
      },
      () => install({ packageName: spec }),
    );
    writeOut(
      `installed ${entry?.packageName ?? spec}\nsource: ${result.installed}\nplugins dir: ${result.dir}\n`,
    );
    return 0;
  } catch (err) {
    writeErr(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

async function runMarketplaceRemove(
  argv: MarketplaceArgv,
  catalog: ReadonlyArray<MarketplaceCatalogEntry>,
  deps: RunMarketplaceCommandDeps,
): Promise<number> {
  const target = argv.positional[1];
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  if (!target) {
    writeErr('error: marketplace remove requires a plugin id or package name\n');
    return 2;
  }

  const packageName = resolveMarketplacePackageName(target, catalog);
  const label = resolveMarketplaceEntry(target, catalog)?.label ?? packageName;
  try {
    const remove = deps.removePluginPackage ?? removePluginPackage;
    const clearState = deps.clearPluginState ?? clearPluginState;
    const result = await withMarketplaceProgress(
      deps,
      {
        start: `Removing ${label}...`,
        stop: `Removed ${label}`,
        error: 'Remove failed',
      },
      async () => {
        const removeResult = await remove({ packageName });
        await clearState(packageName);
        return removeResult;
      },
    );
    writeOut(`removed ${result.removed}\nplugins dir: ${result.dir}\n`);
    return 0;
  } catch (err) {
    writeErr(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

async function runMarketplaceEnable(
  argv: MarketplaceArgv,
  catalog: ReadonlyArray<MarketplaceCatalogEntry>,
  deps: RunMarketplaceCommandDeps,
  enabled: boolean,
): Promise<number> {
  const target = argv.positional[1];
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  if (!target) {
    writeErr(`error: marketplace ${enabled ? 'enable' : 'disable'} requires a plugin id or package name\n`);
    return 2;
  }

  const packageName = resolveMarketplacePackageName(target, catalog);
  try {
    const setEnabled = deps.setPluginEnabled ?? setPluginEnabled;
    await setEnabled(packageName, enabled);
    writeOut(`${enabled ? 'enabled' : 'disabled'} ${packageName}\n`);
    return 0;
  } catch (err) {
    writeErr(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

async function runMarketplaceOpen(
  argv: MarketplaceArgv,
  catalog: ReadonlyArray<MarketplaceCatalogEntry>,
  deps: RunMarketplaceCommandDeps,
): Promise<number> {
  const target = argv.positional[1];
  const writeOut = deps.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text) => process.stderr.write(text));
  if (!target) {
    writeErr('error: marketplace open requires a plugin id or package name\n');
    return 2;
  }

  const entry = resolveMarketplaceEntry(target, catalog);
  const packageName = entry?.packageName ?? target;
  const disabled = await (deps.isPluginDisabled ?? isPluginDisabled)(packageName);
  if (disabled) {
    writeErr(
      `error: ${packageName} is disabled. Run \`moxxy marketplace enable ${entry?.id ?? packageName}\` first.\n`,
    );
    return 1;
  }

  if (!deps.startUiPlugin) {
    writeOut(entry?.startCommand ? `${entry.startCommand}\n` : `moxxy marketplace open ${packageName}\n`);
    return 0;
  }

  return deps.startUiPlugin(buildMarketplaceOpenArgv(argv, packageName, entry?.openFlags));
}

async function defaultSelectPlugin(input: {
  readonly message: string;
  readonly options: ReadonlyArray<MarketplaceOption>;
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

async function defaultSelectAction(input: {
  readonly message: string;
  readonly options: ReadonlyArray<MarketplaceActionOption>;
}): Promise<MarketplaceAction | symbol> {
  return await select<MarketplaceAction>({
    message: input.message,
    options: input.options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
  });
}

function hasHelpFlag(argv: MarketplaceArgv): boolean {
  return Boolean(argv.flags.help || argv.flags.h);
}

function stringFlag(argv: MarketplaceArgv, name: string): string | undefined {
  const value = argv.flags[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === 'string' ? last : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withMarketplaceProgress<T>(
  deps: RunMarketplaceCommandDeps,
  messages: { readonly start: string; readonly stop: string; readonly error: string },
  task: () => Promise<T>,
): Promise<T> {
  if (!shouldShowProgress(deps)) return await task();

  const progress = (deps.createSpinner ?? (() => spinner({ indicator: 'timer' })))();
  progress.start(messages.start);
  try {
    const result = await task();
    progress.stop(messages.stop);
    return result;
  } catch (err) {
    progress.error(messages.error);
    throw err;
  }
}

function shouldShowProgress(deps: RunMarketplaceCommandDeps): boolean {
  if (deps.createSpinner) return true;
  return (deps.isInteractive ?? (() => Boolean(process.stdout.isTTY)))();
}
