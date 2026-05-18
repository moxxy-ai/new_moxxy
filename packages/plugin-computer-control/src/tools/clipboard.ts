import { defineTool, z } from '@moxxy/sdk';
import { ensureDarwin, runProcess } from '../shell.js';

export const clipboardTool = defineTool({
  name: 'computer_clipboard',
  description:
    'Read from or write to the macOS clipboard. Use `read` to fetch what the ' +
    'user just copied; use `write` to stage text the user can then paste with ' +
    '⌘V. Writing the clipboard does NOT trigger a paste — call computer_key ' +
    'with cmd+v after if you need to paste.',
  inputSchema: z.object({
    action: z.enum(['read', 'write']),
    text: z
      .string()
      .max(64_000)
      .optional()
      .describe('Text to put on the clipboard. Required when action="write".'),
  }),
  permission: { action: 'prompt' },
  async handler({ action, text }, ctx) {
    ensureDarwin('computer_clipboard');
    if (action === 'read') {
      const proc = await runProcess('pbpaste', [], {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        timeoutMs: 5_000,
      });
      if (proc.exitCode !== 0) {
        throw new Error(`pbpaste failed (exit ${proc.exitCode}): ${proc.stderr.trim()}`);
      }
      return { ok: true, text: proc.stdout };
    }
    if (text === undefined) {
      throw new Error('computer_clipboard: `text` is required when action="write"');
    }
    const proc = await runProcess('pbcopy', [], {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      input: text,
      timeoutMs: 5_000,
    });
    if (proc.exitCode !== 0) {
      throw new Error(`pbcopy failed (exit ${proc.exitCode}): ${proc.stderr.trim()}`);
    }
    return { ok: true, length: text.length };
  },
});
