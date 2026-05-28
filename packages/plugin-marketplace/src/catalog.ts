export interface MarketplaceCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly packageName: string;
  readonly installSpec: string;
  readonly startCommand?: string;
  readonly openFlags?: Readonly<Record<string, string | boolean>>;
  readonly defaultPort?: number;
  readonly kind?: 'ui' | 'runtime' | 'cli';
}

export interface MarketplaceOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export type MarketplaceAction = 'install' | 'open' | 'enable' | 'disable' | 'remove' | 'back';

export interface MarketplaceActionOption {
  readonly value: MarketplaceAction;
  readonly label: string;
  readonly hint: string;
}

export type MarketplacePluginStatus = 'not installed' | 'installed' | 'disabled';

export const DEFAULT_MARKETPLACE_CATALOG: ReadonlyArray<MarketplaceCatalogEntry> = [
  {
    id: 'virtual-office',
    label: 'Virtual Office',
    description: 'Pixel-art UI for running Moxxy with an office view and session picker.',
    packageName: '@moxxy/virtual-office-plugin',
    installSpec: 'github:moxxy-ai/virtual-office-plugin#main',
    startCommand: 'moxxy marketplace open virtual-office --tui',
    openFlags: { tui: true },
    defaultPort: 17901,
    kind: 'ui',
  },
];

export function resolveMarketplaceEntry(
  target: string,
  catalog: ReadonlyArray<MarketplaceCatalogEntry> = DEFAULT_MARKETPLACE_CATALOG,
): MarketplaceCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === target || entry.packageName === target);
}

export function resolveMarketplacePackageName(
  target: string,
  catalog: ReadonlyArray<MarketplaceCatalogEntry> = DEFAULT_MARKETPLACE_CATALOG,
): string {
  return resolveMarketplaceEntry(target, catalog)?.packageName ?? target;
}

export function buildMarketplaceOptions(input: {
  readonly catalog: ReadonlyArray<MarketplaceCatalogEntry>;
  readonly installedPackageNames: ReadonlySet<string>;
  readonly disabledPackageNames: ReadonlySet<string>;
}): MarketplaceOption[] {
  return input.catalog.map((entry) => ({
    value: entry.id,
    label: entry.label,
    hint: formatMarketplaceStatus(entry, input.installedPackageNames, input.disabledPackageNames),
  }));
}

export function buildMarketplaceActionOptions(input: {
  readonly entry: MarketplaceCatalogEntry;
  readonly installedPackageNames: ReadonlySet<string>;
  readonly disabledPackageNames: ReadonlySet<string>;
}): MarketplaceActionOption[] {
  const installed = input.installedPackageNames.has(input.entry.packageName);
  const disabled = input.disabledPackageNames.has(input.entry.packageName);
  const options: MarketplaceActionOption[] = [];

  if (!installed) {
    options.push({
      value: 'install',
      label: 'Install',
      hint: input.entry.installSpec,
    });
  } else if (disabled) {
    options.push({
      value: 'enable',
      label: 'Enable',
      hint: 'allow this plugin to run',
    });
    options.push({
      value: 'remove',
      label: 'Remove',
      hint: 'uninstall from ~/.moxxy/plugins',
    });
  } else {
    if (input.entry.kind === 'ui') {
      options.push({
        value: 'open',
        label: 'Open',
        hint: input.entry.startCommand ?? `moxxy marketplace open ${input.entry.id}`,
      });
    }
    options.push({
      value: 'disable',
      label: 'Disable',
      hint: 'keep installed, but block startup',
    });
    options.push({
      value: 'remove',
      label: 'Remove',
      hint: 'uninstall from ~/.moxxy/plugins',
    });
  }

  options.push({
    value: 'back',
    label: 'Back',
    hint: 'return without changes',
  });
  return options;
}

export function formatMarketplaceStatus(
  entry: MarketplaceCatalogEntry,
  installedPackageNames: ReadonlySet<string>,
  disabledPackageNames: ReadonlySet<string>,
): string {
  if (!installedPackageNames.has(entry.packageName)) return `not installed · ${entry.installSpec}`;
  if (disabledPackageNames.has(entry.packageName)) return 'disabled';
  return entry.startCommand ? `installed · ${entry.startCommand}` : 'installed';
}

export function buildInstallSpec(input: {
  readonly target: string;
  readonly version?: string;
  readonly ref?: string;
  readonly catalog?: ReadonlyArray<MarketplaceCatalogEntry>;
}): string {
  const entry = resolveMarketplaceEntry(input.target, input.catalog);
  const base = entry?.installSpec ?? input.target;
  const withRef = input.ref ? applyGitRef(base, input.ref) : base;
  if (entry || input.ref || isGitLikeSpec(withRef) || isPathLikeSpec(withRef)) return withRef;
  return input.version ? `${withRef}@${input.version}` : withRef;
}

export function applyGitRef(spec: string, ref: string): string {
  const trimmed = ref.replace(/^#/, '');
  if (trimmed.length === 0) return spec;
  return spec.replace(/#.*$/, '') + `#${trimmed}`;
}

function isGitLikeSpec(spec: string): boolean {
  return (
    spec.startsWith('github:') ||
    spec.startsWith('git+') ||
    spec.startsWith('https://') ||
    spec.startsWith('ssh://') ||
    spec.includes('.git#')
  );
}

function isPathLikeSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~');
}
