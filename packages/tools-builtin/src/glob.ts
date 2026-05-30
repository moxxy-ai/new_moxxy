import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defineTool, z } from '@moxxy/sdk';
import { clampString, globToRegExp, IGNORED_DIR_NAMES, resolvePath } from './util.js';

export const globTool = defineTool({
  name: 'Glob',
  description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Returns absolute paths sorted by mtime descending.',
  inputSchema: z.object({
    pattern: z.string().min(1),
    cwd: z.string().optional(),
    max: z.number().int().positive().max(5000).optional().default(1000),
  }),
  permission: { action: 'prompt' },
  compact: {
    verb: 'Listing',
    noun: { one: 'glob', other: 'globs' },
    previewKey: 'pattern',
  },
  isolation: {
    capabilities: {
      fs: { read: ['$cwd/**'] },
      net: { mode: 'none' },
      timeMs: 30_000,
    },
  },
  async handler({ pattern, cwd, max }, ctx) {
    const baseDir = resolvePath(ctx.cwd, cwd ?? '.');
    const matches: string[] = [];
    for await (const entry of fsGlob(baseDir, pattern, ctx.signal)) {
      matches.push(entry);
      if (matches.length >= max) break;
    }
    const withMtime = await Promise.all(
      matches.map(async (p) => ({ p, mtime: (await fs.stat(p).catch(() => null))?.mtime?.getTime() ?? 0 })),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return clampString(withMtime.map((x) => x.p).join('\n'), 50_000);
  },
});

async function* fsGlob(
  baseDir: string,
  pattern: string,
  signal: AbortSignal,
): AsyncIterable<string> {
  const regex = globToRegExp(pattern);
  // Track resolved dir paths we've already descended into so a self- or
  // cross-symlink cycle doesn't loop forever.
  const visited = new Set<string>();
  yield* walk(baseDir, regex, baseDir, signal, visited);
}

async function* walk(
  root: string,
  regex: RegExp,
  cursor: string,
  signal: AbortSignal,
  visited: Set<string>,
): AsyncIterable<string> {
  if (signal.aborted) return;
  // Resolve via realpath so two different symlinks pointing at the same
  // directory collapse to a single visited entry. If realpath fails (broken
  // link), skip this branch entirely.
  let realCursor: string;
  try {
    realCursor = await fs.realpath(cursor);
  } catch {
    return;
  }
  if (visited.has(realCursor)) return;
  visited.add(realCursor);

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(cursor, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal.aborted) return;
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(cursor, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Resolve the link target's type so a dir-symlink is recursed (not also
      // emitted as a file match) and a file-symlink is matched (not recursed).
      // Without this both branches fired for any symlink.
      try {
        const st = await fs.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // broken link
      }
    }
    if (isDir) {
      yield* walk(root, regex, full, signal, visited);
    }
    if (isFile) {
      const relative = path.relative(root, full);
      if (regex.test(relative)) yield full;
    }
  }
}

