import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defineTool, z } from '@moxxy/sdk';
import { clampString, globToRegExp, resolveSafe } from './util.js';

export const grepTool = defineTool({
  name: 'Grep',
  description: 'Recursively search files for a regex pattern. Returns lines as `path:line:text`.',
  inputSchema: z.object({
    pattern: z.string().min(1),
    cwd: z.string().optional(),
    glob: z.string().optional().describe('Optional file-name glob filter (e.g. "*.ts").'),
    caseInsensitive: z.boolean().optional().default(false),
    maxMatches: z.number().int().positive().max(10_000).optional().default(500),
  }),
  permission: { action: 'prompt' },
  compact: {
    verb: 'Searching for',
    noun: { one: 'pattern', other: 'patterns' },
    previewKey: 'pattern',
  },
  isolation: {
    capabilities: {
      fs: { read: ['$cwd/**'] },
      net: { mode: 'none' },
      timeMs: 60_000,
    },
  },
  async handler({ pattern, cwd, glob, caseInsensitive, maxMatches }, ctx) {
    const baseDir = resolveSafe(ctx.cwd, cwd ?? '.');
    const re = new RegExp(pattern, caseInsensitive ? 'i' : '');
    const fileRe = glob ? globToRegExp(glob) : null;
    const matches: string[] = [];
    await walk(baseDir, baseDir, re, fileRe, matches, maxMatches, ctx.signal);
    return clampString(matches.join('\n'), 100_000);
  },
});

async function walk(
  root: string,
  cursor: string,
  re: RegExp,
  fileRe: RegExp | null,
  matches: string[],
  max: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || matches.length >= max) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(cursor, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal.aborted || matches.length >= max) return;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.turbo') continue;
    const full = path.join(cursor, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, re, fileRe, matches, max, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    if (fileRe && !fileRe.test(entry.name)) continue;
    let content: string;
    try {
      content = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        matches.push(`${path.relative(root, full)}:${i + 1}:${lines[i]}`);
        if (matches.length >= max) return;
      }
    }
  }
}

