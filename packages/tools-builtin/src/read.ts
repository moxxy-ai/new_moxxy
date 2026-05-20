import { promises as fs } from 'node:fs';
import { defineTool, z } from '@moxxy/sdk';
import { clampString, resolveSafe } from './util.js';

export const readTool = defineTool({
  name: 'Read',
  description: 'Read a UTF-8 text file from disk. Returns lines as `cat -n` style numbered text.',
  inputSchema: z.object({
    file_path: z.string().describe('Absolute path or path relative to cwd.'),
    offset: z.number().int().nonnegative().optional().describe('Line offset (0-based).'),
    limit: z.number().int().positive().max(5000).optional().describe('Max lines to return.'),
  }),
  permission: { action: 'prompt' },
  compact: {
    verb: 'Reading',
    noun: { one: 'file', other: 'files' },
    previewKey: 'file_path',
  },
  isolation: {
    capabilities: {
      fs: { read: ['$cwd/**'] },
      net: { mode: 'none' },
      timeMs: 30_000,
    },
  },
  async handler({ file_path, offset = 0, limit = 2000 }, ctx) {
    const resolved = resolveSafe(ctx.cwd, file_path);
    const buf = await fs.readFile(resolved);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const sliced = lines.slice(offset, offset + limit);
    const numbered = sliced
      .map((line, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${line}`)
      .join('\n');
    return clampString(numbered, 200_000);
  },
});
