/**
 * Filesystem browsing for the agent rail's context view.
 *
 * The listDir IPC walks one directory at a time (no recursion) and
 * keeps the resolved path strictly inside the workspace's cwd. That
 * matches the "agent operates in its workspace" mental model and
 * stops the desktop UI from accidentally listing arbitrary paths on
 * disk just because someone passed `../../etc/passwd` as `path`.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const HIDDEN_PREFIX = '.';
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'dist-electron',
  '.next',
  '.cache',
  'coverage',
]);

export interface ListedEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

export interface ListDirResult {
  readonly cwd: string;
  readonly path: string;
  readonly entries: ReadonlyArray<ListedEntry>;
}

/**
 * Resolve `relPath` against `cwd` and verify the result stays
 * underneath `cwd` (or equals it). Throws if the user tried to
 * navigate above the workspace root via `..` or absolute paths.
 */
function resolveInside(cwd: string, relPath: string | undefined): string {
  const abs = relPath
    ? path.resolve(cwd, relPath)
    : path.resolve(cwd);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) {
    throw new Error(`path "${relPath}" escapes the workspace root`);
  }
  return abs;
}

export async function listDir(cwd: string, relPath?: string): Promise<ListDirResult> {
  const abs = resolveInside(cwd, relPath);
  const info = await stat(abs).catch(() => null);
  if (!info || !info.isDirectory()) {
    return {
      cwd,
      path: path.relative(cwd, abs) || '.',
      entries: [],
    };
  }
  const names = await readdir(abs);
  const rows = await Promise.all(
    names.map(async (name) => {
      // Strip ignored directories outright + hide hidden-by-default
      // entries unless the user is already inside one.
      if (IGNORED_DIRS.has(name)) return null;
      if (name.startsWith(HIDDEN_PREFIX) && !relPath?.includes(HIDDEN_PREFIX)) {
        return null;
      }
      try {
        const s = await stat(path.join(abs, name));
        const kind: 'file' | 'dir' = s.isDirectory() ? 'dir' : 'file';
        return { name, kind } satisfies ListedEntry;
      } catch {
        return null;
      }
    }),
  );
  const entries = rows.filter((r): r is ListedEntry => r !== null);
  // Folders before files, alphabetic within each group.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    cwd,
    path: path.relative(cwd, abs) || '.',
    entries,
  };
}
