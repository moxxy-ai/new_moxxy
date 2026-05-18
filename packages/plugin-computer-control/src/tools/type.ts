import { defineTool, z } from '@moxxy/sdk';
import { ensureDarwin, runProcess } from '../shell.js';

export const typeTool = defineTool({
  name: 'computer_type',
  description:
    'Type a string into whatever has keyboard focus. Use AFTER clicking the ' +
    'target field. Macros (cmd+C, etc.) belong in computer_key, not here — this ' +
    'tool sends each character literally. Requires Accessibility permission.',
  inputSchema: z.object({
    text: z
      .string()
      .max(4000)
      .describe(
        'The literal text to type. Newlines and tabs are typed as-is. ' +
          'Pre-existing focus is the target — click first if needed.',
      ),
  }),
  permission: { action: 'prompt' },
  async handler({ text }, ctx) {
    ensureDarwin('computer_type');
    if (text.length === 0) return { ok: true, length: 0 };
    // Pass the literal string to osascript via stdin (with `-`) so we
    // never have to escape AppleScript quote rules. The script reads
    // the contents of stdin into a variable and keystrokes it.
    const script =
      `set theText to (do shell script "cat")\n` +
      `tell application "System Events" to keystroke theText`;
    // The do-shell-script-cat trick: osascript -e <script> reads
    // stdin only when the script asks for it. Simpler approach:
    // serialize the text to an AppleScript string literal ourselves.
    const literal = toAppleScriptString(text);
    const directScript = `tell application "System Events" to keystroke ${literal}`;
    void script;
    const proc = await runProcess('osascript', ['-e', directScript], {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: 30_000,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `type failed (exit ${proc.exitCode}): ${proc.stderr.trim() || '(check Accessibility permission)'}`,
      );
    }
    return { ok: true, length: text.length };
  },
});

/**
 * Serialize an arbitrary JS string into a valid AppleScript string
 * literal. AppleScript string syntax: `"..."` with `\"` and `\\` as
 * the only escapes; newlines are written as `" & return & "`.
 */
function toAppleScriptString(s: string): string {
  // Split on newlines to use `return` (AppleScript's CR constant) so
  // a multi-line type call sends actual Enter keystrokes rather than a
  // literal `\n` in one keystroke (which keystroke would refuse).
  const parts = s.split('\n').map((line) => {
    const escaped = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  return parts.join(' & return & ');
}
