import { defineTool, z } from '@moxxy/sdk';
import { ensureDarwin, runProcess } from '../shell.js';

export const clickTool = defineTool({
  name: 'computer_click',
  description:
    'Click the mouse at screen-pixel coordinates (top-left origin). Uses macOS ' +
    'System Events; requires Accessibility permission on first use. Pass count=2 ' +
    'for a double-click. Right/middle buttons are not supported via this tool — ' +
    'use computer_applescript for those (rare).',
  inputSchema: z.object({
    x: z.number().int().min(0).describe('X pixel from the top-left of the display.'),
    y: z.number().int().min(0).describe('Y pixel from the top-left of the display.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe('Number of consecutive clicks. 1 = single, 2 = double, 3 = triple. Default 1.'),
  }),
  permission: { action: 'prompt' },
  async handler({ x, y, count }, ctx) {
    ensureDarwin('computer_click');
    const n = count ?? 1;
    // `click at {x, y}` repeats N times via a repeat block. Use a
    // bare AppleScript string with numeric interpolation — no
    // user-supplied text reaches the script, so injection isn't a
    // risk here.
    const script =
      `tell application "System Events"\n` +
      `  repeat ${n} times\n` +
      `    click at {${Math.round(x)}, ${Math.round(y)}}\n` +
      `  end repeat\n` +
      `end tell`;
    const proc = await runProcess('osascript', ['-e', script], {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: 10_000,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `click failed (exit ${proc.exitCode}): ${proc.stderr.trim() || '(check Accessibility permission in System Settings → Privacy & Security → Accessibility)'}`,
      );
    }
    return { ok: true, x, y, count: n };
  },
});
