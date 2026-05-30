import { MoxxyError, defineTool, writeFileAtomic, z } from '@moxxy/sdk';
import { resolvePath } from './util.js';

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
    const resolved = resolvePath(ctx.cwd, file_path);
    // Bail before touching disk if the turn was already aborted: a partial
    // write here would corrupt the user's file for no benefit.
    if (ctx.signal.aborted) {
      throw new MoxxyError({ code: 'ABORTED', message: `Write aborted before start: ${resolved}` });
    }
    // Atomic whole-file write (tmp + rename) so a crash/abort mid-write can't
    // leave a truncated file. writeFileAtomic creates parent dirs.
    await writeFileAtomic(resolved, content);
    return `wrote ${content.length} chars to ${resolved}`;
  },
});
