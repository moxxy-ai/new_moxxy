import { defineTool, z } from '@moxxy/sdk';
import { ensureDarwin, runProcess } from '../shell.js';

const MODIFIER_NAMES = ['cmd', 'shift', 'option', 'control'] as const;
type Modifier = (typeof MODIFIER_NAMES)[number];

/**
 * Named keys → macOS key codes used by AppleScript's
 * `key code N` command. Subset focused on what an automation agent
 * actually needs (navigation, editing, function keys). Letters and
 * digits go through `keystroke "x" using ...` instead of `key code`.
 */
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  escape: 53,
  esc: 53,
  delete: 51,
  backspace: 51,
  forward_delete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  page_up: 116,
  page_down: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export const keyTool = defineTool({
  name: 'computer_key',
  description:
    'Send a single key chord with optional modifiers. Use this for shortcuts ' +
    '(cmd+c, cmd+tab, cmd+shift+4) and named keys (return, tab, escape, arrows, ' +
    'page_up/down, f1–f12). For typing arbitrary text, use computer_type.',
  inputSchema: z.object({
    key: z
      .string()
      .min(1)
      .describe(
        'A single character ("a", "1", "/") OR a named key from the catalog: ' +
          Object.keys(KEY_CODES).join(', ') +
          '.',
      ),
    modifiers: z
      .array(z.enum(MODIFIER_NAMES))
      .optional()
      .describe(
        'Held modifiers. Common combos: ["cmd"] for cmd+key, ["cmd","shift"], ["control","option"].',
      ),
  }),
  permission: { action: 'prompt' },
  async handler({ key, modifiers }, ctx) {
    ensureDarwin('computer_key');
    const mods = modifiers ?? [];
    const usingClause = mods.length > 0 ? ` using {${mods.map(modifierClause).join(', ')}}` : '';
    let script: string;
    const lower = key.toLowerCase();
    if (lower in KEY_CODES) {
      script = `tell application "System Events" to key code ${KEY_CODES[lower]}${usingClause}`;
    } else if (key.length === 1) {
      const literal = `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      script = `tell application "System Events" to keystroke ${literal}${usingClause}`;
    } else {
      throw new Error(
        `unknown key "${key}". Use a single character or one of: ${Object.keys(KEY_CODES).join(', ')}.`,
      );
    }
    const proc = await runProcess('osascript', ['-e', script], {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: 10_000,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `key failed (exit ${proc.exitCode}): ${proc.stderr.trim() || '(check Accessibility permission)'}`,
      );
    }
    return { ok: true, key, modifiers: mods };
  },
});

function modifierClause(m: Modifier): string {
  // AppleScript uses "command down", "shift down", "option down",
  // "control down" — map our short names.
  switch (m) {
    case 'cmd':
      return 'command down';
    case 'shift':
      return 'shift down';
    case 'option':
      return 'option down';
    case 'control':
      return 'control down';
  }
}
