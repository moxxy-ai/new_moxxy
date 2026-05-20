import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defineTool, z } from '@moxxy/sdk';
import { resolveSafe } from './util.js';

export const writeTool = defineTool({
  name: 'Write',
  description: 'Write a UTF-8 file to disk, creating parent directories as needed. Overwrites if exists.',
  inputSchema: z.object({
    file_path: z.string(),
    content: z.string(),
  }),
  permission: { action: 'prompt' },
  compact: {
    verb: 'Writing',
    noun: { one: 'file', other: 'files' },
    previewKey: 'file_path',
  },
  isolation: {
    capabilities: {
      fs: { read: ['$cwd/**'], write: ['$cwd/**'] },
      net: { mode: 'none' },
      timeMs: 30_000,
    },
  },
  async handler({ file_path, content }, ctx) {
    const resolved = resolveSafe(ctx.cwd, file_path);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return `wrote ${content.length} chars to ${resolved}`;
  },
});
