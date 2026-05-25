import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPluginLoader,
  discoverPlugins,
  PluginRequirementError,
  readPackageMoxxyRequirements,
  type Logger,
  type PluginSkipRecord,
  type Session,
} from '@moxxy/core';
import type { MoxxyConfig } from '@moxxy/config';
import { isPureUiPluginManifest, type MoxxyRequirement } from '@moxxy/sdk';
import type { BuiltinEntry } from './builtins.js';
import { BUILTIN_REQUIREMENTS } from './builtin-requirements.generated.js';

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
 *
 * Requirements for each builtin are resolved from the builtin's own
 * `package.json#moxxy.requirements` field — there are no hardcoded
 * requirement lists in CLI code. Builtins are toposorted by those
 * resolved requirements so a dependent loads after its prerequisites.
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

  const resolved = await resolveBuiltinRequirements(builtins, cwd);
  const ordered = toposortBuiltins(builtins, resolved);
  for (const { name, plugin } of ordered) {
    if (config.plugins?.[name]?.enabled === false) {
      logger.info('skipping disabled plugin', { plugin: name });
      continue;
    }
    const requirements = resolved.get(name);
    try {
      session.pluginHost.registerStatic(plugin, requirements ? { requirements } : {});
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
      if (isPureUiPluginManifest(manifest)) {
        logger.info('auto-discovery: registered UI plugin metadata', {
          package: manifest.packageName,
          port: manifest.port,
          from: manifest.packagePath,
        });
        continue;
      }
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

/**
 * For each builtin entry, resolve `moxxy.requirements`. The compiled-in
 * manifest (`BUILTIN_REQUIREMENTS`, generated at build from each package's
 * package.json) is consulted first so gating + toposort survive bundling —
 * once the cli is published as a single bundle the on-disk package.json is
 * gone and the disk lookup below would return `[]`. Packages absent from the
 * manifest fall back to the disk lookup, which still serves from-source dev
 * runs and any third-party plugin resolvable from `cwd`.
 *
 * Returns a map keyed by BuiltinEntry.name. Entries with no requirements
 * (e.g. virtual sub-plugins built dynamically inside another package) end up
 * with no entry — i.e. zero static requirements, which is correct:
 * requirements live in package.json or they don't exist.
 */
async function resolveBuiltinRequirements(
  builtins: ReadonlyArray<BuiltinEntry>,
  cwd: string,
): Promise<Map<string, ReadonlyArray<MoxxyRequirement>>> {
  const out = new Map<string, ReadonlyArray<MoxxyRequirement>>();
  await Promise.all(
    builtins.map(async (entry) => {
      const compiled = BUILTIN_REQUIREMENTS[entry.name];
      if (compiled !== undefined) {
        if (compiled.length > 0) out.set(entry.name, compiled);
        return;
      }
      const reqs = await readPackageMoxxyRequirements(entry.name, cwd);
      if (reqs.length > 0) out.set(entry.name, reqs);
    }),
  );
  return out;
}

function toposortBuiltins(
  entries: ReadonlyArray<BuiltinEntry>,
  requirementsByName: ReadonlyMap<string, ReadonlyArray<MoxxyRequirement>>,
): ReadonlyArray<BuiltinEntry> {
  const byPluginName = new Map<string, BuiltinEntry>();
  for (const e of entries) byPluginName.set(e.plugin.name, e);

  const order: BuiltinEntry[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  const visit = (entry: BuiltinEntry): void => {
    if (visited.has(entry.plugin.name)) return;
    if (onStack.has(entry.plugin.name)) {
      // Cycle: bail to original insertion order rather than throwing —
      // builtins are author-controlled and the failure should surface as
      // a missing-requirement diagnostic, not a hard crash at boot.
      return;
    }
    onStack.add(entry.plugin.name);
    for (const depName of pluginDeps(requirementsByName.get(entry.name))) {
      const dep = byPluginName.get(depName);
      if (dep) visit(dep);
    }
    onStack.delete(entry.plugin.name);
    visited.add(entry.plugin.name);
    order.push(entry);
  };

  for (const e of entries) visit(e);
  return order;
}

function pluginDeps(
  requirements: ReadonlyArray<MoxxyRequirement> | undefined,
): ReadonlyArray<string> {
  if (!requirements) return [];
  const out: string[] = [];
  for (const req of requirements) {
    if (req.kind === 'plugin') out.push(req.name);
  }
  return out;
}
