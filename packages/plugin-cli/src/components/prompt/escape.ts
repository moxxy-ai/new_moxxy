export interface EscapeMatch {
  action:
    | 'left'
    | 'right'
    | 'up'
    | 'down'
    | 'word-left'
    | 'word-right'
    | 'home'
    | 'end'
    | 'delete'
    | 'word-back-delete'
    | 'esc-clear'
    | 'alt-enter'
    | 'command-hotkey';
  len: number;
  letter?: string;
}

export function matchEscape(rest: string): EscapeMatch | null {
  // CSI sequences (ESC [ ...)
  if (rest.startsWith('\x1b[')) {
    // Kitty keyboard protocol: CSI <keycode>(;<modifiers>)? u
    // Activated via `\x1b[>1u` on mount. Lets us distinguish Shift+Enter
    // (CSI 13;2 u) from plain Enter (still 0x0D). Modifier bits:
    //   1 = no modifier, 2 = shift, 3 = alt, 4 = shift+alt, 5 = ctrl, …
    // Anything other than "plain" treated as a newline insert; the rare
    // "ctrl+enter" / "alt+enter" all imply "new line" in our model.
    const kitty = /^\x1b\[(\d+)(?:;(\d+))?u/.exec(rest);
    if (kitty) {
      const keycode = Number(kitty[1]);
      const modifiers = Number(kitty[2] ?? '1');
      if (keycode === 13 && modifiers > 1) {
        return { action: 'alt-enter', len: kitty[0].length };
      }
      if (hasCtrlModifier(modifiers)) {
        const letter = keycodeToLetter(keycode);
        if (letter) {
          return { action: 'command-hotkey', letter, len: kitty[0].length };
        }
      }
      // Other kitty-encoded keys we don't handle yet — consume so we
      // don't render them as junk text.
      return { action: 'esc-clear' as never, len: kitty[0].length };
    }
    // 3-byte arrows
    if (rest.length < 3) return null;
    const csi3 = rest.charAt(2);
    if (csi3 === 'A') return { action: 'up', len: 3 };
    if (csi3 === 'B') return { action: 'down', len: 3 };
    if (csi3 === 'C') return { action: 'right', len: 3 };
    if (csi3 === 'D') return { action: 'left', len: 3 };
    if (csi3 === 'H') return { action: 'home', len: 3 };
    if (csi3 === 'F') return { action: 'end', len: 3 };
    // CSI 3~ delete, CSI 1;3D alt-left, etc.
    if (rest.startsWith('\x1b[3~')) return { action: 'delete', len: 4 };
    if (rest.startsWith('\x1b[1~') || rest.startsWith('\x1b[7~')) return { action: 'home', len: 4 };
    if (rest.startsWith('\x1b[4~') || rest.startsWith('\x1b[8~')) return { action: 'end', len: 4 };
    // Alt-arrow variants
    if (rest.startsWith('\x1b[1;3D') || rest.startsWith('\x1b[1;5D'))
      return { action: 'word-left', len: 6 };
    if (rest.startsWith('\x1b[1;3C') || rest.startsWith('\x1b[1;5C'))
      return { action: 'word-right', len: 6 };
    if (rest.startsWith('\x1b[1;3A') || rest.startsWith('\x1b[1;5A')) return { action: 'up', len: 6 };
    if (rest.startsWith('\x1b[1;3B') || rest.startsWith('\x1b[1;5B'))
      return { action: 'down', len: 6 };
    // Partial CSI we don't know — consume up to the terminator letter
    // (final byte is in @–~ range) so we don't get stuck on it.
    for (let j = 2; j < rest.length; j += 1) {
      const ch = rest.charCodeAt(j);
      if (ch >= 0x40 && ch <= 0x7e) return { action: 'esc-clear' as never, len: j + 1 };
    }
    return null; // need more data
  }
  // ESC SS3 sequences (rare: home/end in some terminals)
  if (rest.startsWith('\x1bO')) {
    if (rest.length < 3) return null;
    const c = rest.charAt(2);
    if (c === 'H') return { action: 'home', len: 3 };
    if (c === 'F') return { action: 'end', len: 3 };
    return { action: 'esc-clear' as never, len: 3 };
  }
  // Meta (Alt) + key: ESC <char>
  if (rest.length < 2) return null;
  const next = rest.charAt(1);
  if (next === 'b') return { action: 'word-left', len: 2 };
  if (next === 'f') return { action: 'word-right', len: 2 };
  if (next === '\x7f') return { action: 'word-back-delete', len: 2 };
  if (next === '\r' || next === '\n') return { action: 'alt-enter', len: 2 };
  if (next === '\x1b') return { action: 'esc-clear', len: 1 };
  // Standalone ESC = clear input
  if (rest.length === 1) return { action: 'esc-clear', len: 1 };
  // Unknown Alt+key — eat the prefix only, leave the trailing key for
  // the next iteration to handle as printable.
  return { action: 'esc-clear' as never, len: 1 };
}

function hasCtrlModifier(modifiers: number): boolean {
  return ((modifiers - 1) & 4) !== 0;
}

function keycodeToLetter(keycode: number): string | undefined {
  if (keycode >= 65 && keycode <= 90) return String.fromCharCode(keycode + 32);
  if (keycode >= 97 && keycode <= 122) return String.fromCharCode(keycode);
  return undefined;
}
