import { defineTool, z } from '@moxxy/sdk';
import { ensureDarwin, runProcess } from '../shell.js';

export const applescriptTool = defineTool({
  name: 'computer_applescript',
  description:
    'Escape hatch: run an arbitrary AppleScript snippet via `osascript`. Use ' +
    'for anything the dedicated tools can\'t cover (frontmost app name, list ' +
    'open Safari tabs, drive a specific app via its scripting dictionary, etc.). ' +
    'Returns the script\'s stdout. The user approves every invocation — keep ' +
    'scripts focused and reversible.',
  inputSchema: z.object({
    script: z
      .string()
      .min(1)
      .max(8000)
      .describe(
        'AppleScript source. Multi-line is fine — pass `\\n` between statements. ' +
          'For JavaScript for Automation, prefix with `#!/usr/bin/osascript -l JavaScript`',
      ),
  }),
  permission: { action: 'prompt' },
  async handler({ script }, ctx) {
    ensureDarwin('computer_applescript');
    const proc = await runProcess('osascript', ['-e', script], {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: 30_000,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `osascript failed (exit ${proc.exitCode}): ${proc.stderr.trim() || '(no error message)'}`,
      );
    }
    return { ok: true, output: proc.stdout.trim() };
  },
});
