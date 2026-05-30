import { promises as fs } from 'node:fs';
import { MoxxyError, defineTool, writeFileAtomic, z } from '@moxxy/sdk';
import { resolvePath } from './util.js';

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
    const resolved = resolvePath(ctx.cwd, file_path);
    // Bail before reading/writing if the turn was already aborted: a partial
    // write here would corrupt the user's file for no benefit.
    if (ctx.signal.aborted) {
      throw new MoxxyError({ code: 'ABORTED', message: `Edit aborted before start: ${resolved}` });
    }
    const original = await fs.readFile(resolved, 'utf8');
    let updated: string;
    // Number of replace_all occurrences, derived from the same split that
    // produces `updated` so large files are only split once. -1 when the
    // single-replacement branch ran (occurrence count is always 1 there).
    let replaceAllOccurrences = -1;
    if (replace_all) {
      const parts = original.split(old_string);
      updated = parts.join(new_string);
      replaceAllOccurrences = parts.length - 1;
      if (updated === original)
        throw new MoxxyError({ code: 'TOOL_ERROR', message: `old_string not found in ${resolved}` });
    } else {
      const first = original.indexOf(old_string);
      if (first === -1)
        throw new MoxxyError({ code: 'TOOL_ERROR', message: `old_string not found in ${resolved}` });
      const next = original.indexOf(old_string, first + old_string.length);
      if (next !== -1) {
        throw new MoxxyError({
          code: 'TOOL_ERROR',
          message: `old_string is not unique in ${resolved}. Provide more context or set replace_all: true.`,
        });
      }
      updated = original.slice(0, first) + new_string + original.slice(first + old_string.length);
    }
    // Atomic whole-file write (tmp + rename) so a crash/abort mid-write can't
    // leave a truncated file.
    await writeFileAtomic(resolved, updated);
    const occurrences = replace_all ? replaceAllOccurrences : 1;
    return `edited ${resolved}: ${occurrences} replacement${occurrences === 1 ? '' : 's'}`;
  },
});
