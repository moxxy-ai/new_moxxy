import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { moxxyPackageSchema, type ResolvedPluginManifest } from '@moxxy/sdk';
import type { Logger } from '../logger.js';

/**
 * Maximum number of directory levels to climb when collecting `node_modules`
 * roots from the cwd upward. Bounds the walk so discovery never traverses all
 * the way to the filesystem root on a deeply-nested cwd.
 */
const MAX_NODE_MODULES_WALK_DEPTH = 8;

export interface DiscoveryOptions {
  readonly cwd: string;
  readonly logger: Logger;
  readonly extraPaths?: ReadonlyArray<string>;
}

export async function discoverPlugins(opts: DiscoveryOptions): Promise<ReadonlyArray<ResolvedPluginManifest>> {
  const seen = new Set<string>();
  const out: ResolvedPluginManifest[] = [];

  const roots = await candidateRoots(opts.cwd);
  for (const extra of opts.extraPaths ?? []) roots.push(extra);

  for (const root of roots) {
    let pkgsDirs: string[];
    try {
      pkgsDirs = await listPackageDirs(root);
    } catch (err) {
      opts.logger.debug('discovery: failed to list packages in root', { root, err: String(err) });
      continue;
    }
    for (const pkgPath of pkgsDirs) {
      if (seen.has(pkgPath)) continue;
      seen.add(pkgPath);
      const manifest = await readPluginManifest(pkgPath, opts.logger);
      if (manifest) out.push(manifest);
    }
  }
  return out;
}

async function candidateRoots(cwd: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = path.resolve(cwd);
  for (let i = 0; i < MAX_NODE_MODULES_WALK_DEPTH; i++) {
    out.push(path.join(cursor, 'node_modules'));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return out;
}

async function listPackageDirs(root: string): Promise<string[]> {
  const entries: import('node:fs').Dirent[] = await fs
    .readdir(root, { withFileTypes: true })
    .catch((): import('node:fs').Dirent[] => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.name.startsWith('@')) {
      const sub: import('node:fs').Dirent[] = await fs
        .readdir(full, { withFileTypes: true })
        .catch((): import('node:fs').Dirent[] => []);
      for (const s of sub) {
        if (s.isDirectory() || s.isSymbolicLink()) out.push(path.join(full, s.name));
      }
    } else if (entry.name !== '.bin' && entry.name !== '.pnpm') {
      out.push(full);
    }
  }
  return out;
}

async function readPluginManifest(
  packagePath: string,
  logger: Logger,
): Promise<ResolvedPluginManifest | null> {
  const pkgJsonPath = path.join(packagePath, 'package.json');
  let pkg: { name?: string; version?: string; moxxy?: unknown };
  try {
    pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
  if (!pkg.moxxy) return null;
  if (!pkg.name) return null;

  const parsedMoxxy = moxxyPackageSchema.safeParse(pkg.moxxy);
  if (!parsedMoxxy.success) {
    logger.warn('discovery: invalid moxxy package config, skipping', {
      package: pkg.name,
      issues: parsedMoxxy.error.issues,
    });
    return null;
  }

  const { plugin, requirements } = parsedMoxxy.data;
  if (!plugin) return null;

  return {
    ...plugin,
    packageName: pkg.name,
    packageVersion: pkg.version ?? '0.0.0',
    packagePath,
    ...(requirements ? { requirements } : {}),
  };
}
