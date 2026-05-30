import { definePlugin, type Plugin } from '@moxxy/sdk';
import {
  buildInstallPluginTool,
  installPluginPackage,
  removePluginPackage,
  userPluginsDir,
  type InstallPluginDeps,
  type InstallPluginPackageOptions,
  type InstallPluginPackageResult,
  type RemovePluginPackageOptions,
  type RemovePluginPackageResult,
  type PluginSnapshot,
} from './install.js';

export {
  buildInstallPluginTool,
  installPluginPackage,
  removePluginPackage,
  userPluginsDir,
  type InstallPluginDeps,
  type InstallPluginPackageOptions,
  type InstallPluginPackageResult,
  type RemovePluginPackageOptions,
  type RemovePluginPackageResult,
  type PluginSnapshot,
} from './install.js';

export interface BuildPluginsAdminOpts {
  /**
   * How the install tool hot-reloads after a successful install.
   * Closure-bound so this package doesn't import core.
   */
  readonly reload: () => Promise<void>;
  /**
   * Returns a snapshot of currently-registered contributions so the
   * tool can report what the new install brought in. Typically reads
   * `session.tools.list()`, `session.agents.list()`, etc.
   */
  readonly snapshot: () => PluginSnapshot;
}

/**
 * `@moxxy/plugin-plugins-admin` — exposes the `install_plugin` tool so
 * the model can install new moxxy plugins on the user's behalf. The
 * tool shells out to `npm install --prefix ~/.moxxy/plugins` then
 * hot-reloads the host. Disable this plugin to lock the plugin set.
 */
export function buildPluginsAdminPlugin(opts: BuildPluginsAdminOpts): Plugin {
  const deps: InstallPluginDeps = { reload: opts.reload, snapshot: opts.snapshot };
  return definePlugin({
    name: '@moxxy/plugin-plugins-admin',
    version: '0.0.0',
    tools: [buildInstallPluginTool(deps)],
  });
}
