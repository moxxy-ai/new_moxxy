import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPluginLoader,
  discoverPlugins,
  PluginRequirementError,
  type Logger,
  type PluginSkipRecord,
  type Session,
} from '@moxxy/core';
import type { MoxxyConfig } from '@moxxy/config';
import type { BuiltinEntry } from './builtins.js';

export interface RegistrationResult {
  readonly registered: ReadonlySet<string>;
  readonly skipped: ReadonlyArray<PluginSkipRecord>;
}

export interface RegisterPluginsOptions {
  readonly discover?: boolean;
}

/**
 * Register the static builtins (skipping any disabled in config) and
 * auto-discover installed `@moxxy/plugin-*` packages from the project
 * cwd plus `~/.moxxy/plugins` (both the dir itself and its
 * `node_modules` subtree). Discovery failures are logged, not fatal.
 */
export async function registerPlugins(
  session: Session,
  config: MoxxyConfig,
  builtins: ReadonlyArray<BuiltinEntry>,
  cwd: string,
  logger: Logger,
  opts: RegisterPluginsOptions = {},
): Promise<RegistrationResult> {
  const registered = new Set<string>();

  for (const { name, plugin } of builtins) {
    if (config.plugins?.[name]?.enabled === false) {
      logger.info('skipping disabled plugin', { plugin: name });
      continue;
    }
    try {
      session.pluginHost.registerStatic(plugin);
      registered.add(plugin.name);
    } catch (err) {
      if (!(err instanceof PluginRequirementError)) throw err;
      logger.warn('skipping plugin with unmet requirements', {
        plugin: name,
        err: err.message,
      });
    }
  }

  if (opts.discover === false) {
    return { registered, skipped: session.pluginHost.listSkipped() };
  }

  const loader = createPluginLoader({ cwd });
  const userPluginsDir = path.join(os.homedir(), '.moxxy', 'plugins');
  // Scan BOTH the user plugin dir (scaffolded via `moxxy plugins new`,
  // which drops dirs straight under here) AND its node_modules subtree
  // (where `npm install --prefix ~/.moxxy/plugins ...` lands packages
  // installed at runtime by the `install_plugin` tool).
  const userPluginsNodeModules = path.join(userPluginsDir, 'node_modules');

  try {
    const manifests = await discoverPlugins({
      cwd,
      logger,
      extraPaths: [userPluginsDir, userPluginsNodeModules],
    });
    for (const manifest of manifests) {
      if (registered.has(manifest.packageName)) continue;
      if (config.plugins?.[manifest.packageName]?.enabled === false) {
        logger.info('skipping disabled plugin', { plugin: manifest.packageName });
        continue;
      }
      try {
        const plugin = await loader.load(manifest);
        if (registered.has(plugin.name)) continue;
        session.pluginHost.registerDiscovered(plugin, manifest);
        registered.add(plugin.name);
        logger.info('auto-loaded plugin', { plugin: plugin.name, from: manifest.packagePath });
      } catch (err) {
        logger.warn('auto-discovery: failed to load plugin', {
          package: manifest.packageName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('auto-discovery: scan failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return { registered, skipped: session.pluginHost.listSkipped() };
}
