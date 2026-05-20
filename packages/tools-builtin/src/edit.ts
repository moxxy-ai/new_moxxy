import { promises as fs } from 'node:fs';
import { defineTool, z } from '@moxxy/sdk';
import { resolveSafe } from './util.js';

export const editTool = defineTool({
  name: 'Edit',
  description: 'Replace exact string occurrences in a file. Use replace_all to substitute every occurrence; otherwise old_string must be unique.',
  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional().default(false),
  }),
  permission: { action: 'prompt' },
  compact: {
    verb: 'Editing',
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
  async handler({ file_path, old_string, new_string, replace_all }, ctx) {
    const resolved = resolveSafe(ctx.cwd, file_path);
    const original = await fs.readFile(resolved, 'utf8');
    let updated: string;
    if (replace_all) {
      updated = original.split(old_string).join(new_string);
      if (updated === original) throw new Error(`old_string not found in ${resolved}`);
    } else {
      const first = original.indexOf(old_string);
      if (first === -1) throw new Error(`old_string not found in ${resolved}`);
      const next = original.indexOf(old_string, first + old_string.length);
      if (next !== -1) {
        throw new Error(
          `old_string is not unique in ${resolved}. Provide more context or set replace_all: true.`,
        );
      }
      updated = original.slice(0, first) + new_string + original.slice(first + old_string.length);
    }
    await fs.writeFile(resolved, updated, 'utf8');
    const occurrences = replace_all
      ? (original.split(old_string).length - 1)
      : 1;
    return `edited ${resolved}: ${occurrences} replacement${occurrences === 1 ? '' : 's'}`;
  },
});
