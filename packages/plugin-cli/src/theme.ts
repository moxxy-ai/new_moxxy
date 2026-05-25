/**
 * Centralized palette for the Moxxy TUI. Grok-style monochrome:
 * default-color text for active content, dim gray for chrome (borders,
 * footer hints, labels), and a small set of accent colors reserved for
 * state changes the user must notice (busy=yellow, error=red).
 *
 * Components import these tokens instead of hardcoding `color="cyan"`
 * etc., so a future palette tweak is a single-file change.
 */

/**
 * Glyphs used across components. The diamond pair (`◆`/`◇`) is the
 * shared "filled vs pending" indicator — boot checklist, phase markers
 * in the chat scrollback, and any future progress lists all reuse it.
 */
export const Glyphs = {
  /** Completed step / executed action. */
  filled: '◆',
  /** Pending step / waiting action. */
  pending: '◇',
  /** Inline prompt marker (user message, input cursor prefix). */
  prompt: '›',
  /** Waiting / spinner-adjacent indicator. */
  waiting: '∴',
  /** Context-meter "up arrow" used in the header bar. */
  contextUp: '↑',
  /** Cancel hint shown next to turn metrics. */
  cancel: '[×]',
  /** Vertical separator for footer key-hints. */
  hintSep: '│',
  /** Mid-dot separator. */
  midDot: '·',
} as const;

/** Ink color names mapped to semantic roles. */
export const Colors = {
  /** Borders, footer hints, secondary labels. Always paired with `dimColor`. */
  chrome: 'gray',
  /** Yellow — in-flight turn / context warning. */
  busy: 'yellow',
  /** Red — boot failure, permission deny, context near limit. */
  danger: 'red',
  /** Green — accepted state (e.g. active prompt cursor). */
  active: 'green',
  /** Magenta — the active-mode footer below the input. */
  mode: 'magenta',
} as const;

/** Shared border style used by InputBox, ListPicker, dialog panels. */
export const Border = {
  style: 'round' as const,
  color: Colors.chrome,
  dim: true,
} as const;

/** Context-meter color escalation. Used by HeaderBar `↑ <%>`. */
export function contextColor(pct: number): typeof Colors[keyof typeof Colors] | undefined {
  if (pct >= 85) return Colors.danger;
  if (pct >= 60) return Colors.busy;
  return undefined;
}
