import { promises as fs } from 'node:fs';
import { type MoxxyConfig, moxxyConfigSchema } from '@moxxy/config';
import { moxxyPath, writeFileAtomic } from '@moxxy/sdk';
import { parse, stringify } from 'yaml';

export interface MarketplaceConfigOptions {
  readonly configPath?: string;
}

export function defaultUserConfigPath(): string {
  return moxxyPath('config.yaml');
}

export async function loadDisabledPackageNames(
  opts: MarketplaceConfigOptions = {},
): Promise<ReadonlySet<string>> {
  const config = await readUserConfig(opts.configPath ?? defaultUserConfigPath());
  const disabled = new Set<string>();
  for (const [packageName, settings] of Object.entries(config.plugins ?? {})) {
    if (settings?.enabled === false) disabled.add(packageName);
  }
  return disabled;
}

export async function isPluginDisabled(
  packageName: string,
  opts: MarketplaceConfigOptions = {},
): Promise<boolean> {
  return (await loadDisabledPackageNames(opts)).has(packageName);
}

export async function setPluginEnabled(
  packageName: string,
  enabled: boolean,
  opts: MarketplaceConfigOptions = {},
): Promise<void> {
  const configPath = opts.configPath ?? defaultUserConfigPath();
  const config = await readUserConfig(configPath);
  const plugins = { ...(config.plugins ?? {}) };
  plugins[packageName] = { ...(plugins[packageName] ?? {}), enabled };
  await writeUserConfig(configPath, { ...config, plugins });
}

export async function clearPluginState(
  packageName: string,
  opts: MarketplaceConfigOptions = {},
): Promise<void> {
  const configPath = opts.configPath ?? defaultUserConfigPath();
  const config = await readUserConfig(configPath);
  if (!config.plugins || !(packageName in config.plugins)) return;

  const plugins = { ...config.plugins };
  delete plugins[packageName];
  await writeUserConfig(configPath, {
    ...config,
    ...(Object.keys(plugins).length > 0 ? { plugins } : { plugins: undefined }),
  });
}

async function readUserConfig(configPath: string): Promise<MoxxyConfig> {
  let raw = '';
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }

  const parsed = parse(raw) ?? {};
  const result = moxxyConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid moxxy user config at ${configPath}: ${result.error.message}`);
  }
  return result.data;
}

async function writeUserConfig(configPath: string, config: MoxxyConfig): Promise<void> {
  const result = moxxyConfigSchema.safeParse(config);
  if (!result.success) throw new Error(`invalid moxxy user config: ${result.error.message}`);

  await writeFileAtomic(configPath, stringify(result.data));
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
