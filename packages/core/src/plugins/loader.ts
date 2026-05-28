import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, ResolvedPluginManifest } from '@moxxy/sdk';
import type { PluginLoader } from './host.js';

export interface JitiLoaderOptions {
  readonly cwd: string;
  readonly cacheBust?: () => string;
}

let jitiInstance: ((id: string) => unknown) | null = null;

async function getJiti(cwd: string): Promise<((id: string) => unknown) | null> {
  if (jitiInstance) return jitiInstance;
  try {
    const mod = await import('jiti');
    const factory = (mod as { createJiti?: (cwd: string, opts?: unknown) => (id: string) => unknown; default?: (cwd: string, opts?: unknown) => (id: string) => unknown }).createJiti ?? (mod as { default?: (cwd: string, opts?: unknown) => (id: string) => unknown }).default;
    if (!factory) return null;
    jitiInstance = factory(cwd, { interopDefault: true });
    return jitiInstance;
  } catch {
    return null;
  }
}

export function createPluginLoader(opts: JitiLoaderOptions): PluginLoader {
  return {
    async load(manifest: ResolvedPluginManifest): Promise<Plugin> {
      const entry = path.resolve(manifest.packagePath, manifest.entry);
      const isTs = entry.endsWith('.ts') || entry.endsWith('.tsx');

      let mod: unknown;
      if (isTs) {
        const jiti = await getJiti(opts.cwd);
        if (!jiti) {
          throw new Error(
            `Cannot load .ts plugin entry without jiti: ${entry}. Install 'jiti' as a dependency.`,
          );
        }
        mod = jiti(entry);
      } else {
        const bust = opts.cacheBust?.() ?? `${Date.now()}-${Math.random()}`;
        const url = `${pathToFileURL(entry).href}?v=${bust}`;
        mod = await import(url);
      }

      const plugin = extractPlugin(mod);
      if (!plugin) {
        throw new Error(
          `Plugin entry did not export a valid Plugin (default export with __moxxy === 'plugin'): ${entry}`,
        );
      }
      // The runtime-reported version is the package.json version — the single
      // source of truth. Plugin authors hardcode a placeholder `version` in
      // definePlugin (commonly '0.0.0'), so stamp the manifest's packageVersion
      // here; otherwise `moxxy plugins list` and PluginRegisteredEvent lie.
      if (manifest.packageVersion && plugin.version !== manifest.packageVersion) {
        return Object.freeze({ ...plugin, version: manifest.packageVersion });
      }
      return plugin;
    },
  };
}

function extractPlugin(mod: unknown): Plugin | null {
  if (!mod || typeof mod !== 'object') return null;
  const candidates: unknown[] = [
    (mod as { default?: unknown }).default,
    (mod as { default?: { default?: unknown } }).default?.default,
    mod,
    (mod as { plugin?: unknown }).plugin,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && (c as { __moxxy?: string }).__moxxy === 'plugin') {
      return c as Plugin;
    }
  }
  return null;
}
