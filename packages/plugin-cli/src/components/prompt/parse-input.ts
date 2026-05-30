import type { Action } from './reducer.js';
import { matchEscape } from './escape.js';

export interface ParseCtx {
  inPaste: boolean;
  /** Accumulator across chunks: every byte received inside the
   *  current bracketed paste, so the post-paste transform sees the
   *  whole payload — not just the trailing fragment. */
  pasteAccum: { text: string };
  dispatch: (a: Action) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onSlashUp: () => void;
  onSlashDown: () => void;
  onSlashAccept: () => void;
  /** Request TUI shutdown without terminating the hosting process. */
  onExit: () => void;
  /** Shift+Tab — cycles the active mode. No-op when unset. */
  onShiftTab?: () => void;
  onPasteText?: (text: string) => string;
  slashOpen: boolean;
  bufferRef: { current: { buffer: string; cursor: number } };
  /**
   * Optional map of `Ctrl+<letter>` global hotkeys that take effect
   * INSIDE the input. Keys are single lowercase letters. The editor
   * already owns several control combos (a, c, e, h, j, k, u, w, y) so
   * collisions silently no-op — pick from b, d, f, g, l, n, o, p, q,
   * r, s, t, v, x, z and avoid platform-reserved ones (s/q in many
   * terminals, z = suspend).
   *
   * Routing the hotkey here (instead of relying on Ink's `useInput`)
   * works around a Node-streams quirk: PromptInput holds a `data`
   * listener on stdin which switches the stream to flowing mode, after
   * which Ink's `readable`-based handler stops receiving chunks.
   */
  commandHotkeys?: Record<string, () => void>;
}

/**
 * Translate raw stdin bytes into reducer actions. Buffer the latest
 * chunk locally so multi-byte escape sequences that arrive split across
 * `data` events still parse. Returns the consumed length so the caller
 * can keep any partial trailing sequence for the next chunk.
 */
export function parseInputChunk(chunk: string, ctx: ParseCtx): string {
  // Bracketed-paste markers come as full bytes; if we're mid-paste we
  // accumulate every byte until we see the end marker, treating the
  // raw text inside as literal (including `\r` translated to `\n`).
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
  let i = 0;
  let remainder = '';
  while (i < chunk.length) {
    // In paste mode: consume bytes until end marker arrives.
    if (ctx.inPaste) {
      const endIdx = chunk.indexOf(PASTE_END, i);
      if (endIdx < 0) {
        // Collapse CRLF (Windows / many copy sources) to a single LF
        // FIRST so we don't turn it into the double `\n\n` that bare
        // `\r` → `\n` would. Bare `\r` (classic Mac) still maps to LF.
        const data = chunk.slice(i).replace(/\r\n?/g, '\n');
        ctx.pasteAccum.text += data;
        ctx.dispatch({ type: 'paste-append', data });
        return '';
      }
      const inner = chunk.slice(i, endIdx).replace(/\r\n?/g, '\n');
      if (inner) {
        ctx.pasteAccum.text += inner;
        ctx.dispatch({ type: 'paste-append', data: inner });
      }
      // Hand the full paste to the host transform (if installed) so an
      // image path payload can be swapped for `[Image #N]` before it
      // lands in the buffer. Falls through to the raw text otherwise.
      const raw = ctx.pasteAccum.text;
      const transformed = ctx.onPasteText ? ctx.onPasteText(raw) : raw;
      ctx.pasteAccum.text = '';
      ctx.dispatch(
        transformed === raw
          ? { type: 'paste-end' }
          : { type: 'paste-end', overrideText: transformed },
      );
      ctx.inPaste = false;
      i = endIdx + PASTE_END.length;
      continue;
    }
    if (chunk.startsWith(PASTE_START, i)) {
      ctx.pasteAccum.text = '';
      ctx.dispatch({ type: 'paste-start' });
      ctx.inPaste = true;
      i += PASTE_START.length;
      continue;
    }
    const c = chunk[i]!;
    // Control bytes
    if (c === '\r' || c === '\n') {
      // Enter:
      //   - Buffer ends with `\` AND cursor at end → insert newline (strip backslash)
      //   - Otherwise → submit
      // Ctrl+J sends 0x0A directly which is treated the same as Enter
      // since some terminals send it for plain Enter too.
      const buf = ctx.bufferRef.current.buffer;
      const cursor = ctx.bufferRef.current.cursor;
      if (buf.endsWith('\\') && cursor === buf.length) {
        ctx.dispatch({ type: 'insert-newline', stripBackslashAtEnd: true });
      } else {
        ctx.onSubmit();
      }
      i += 1;
      continue;
    }
    if (c === '\x03') {
      ctx.onExit();
      i += 1;
      continue;
    }
    if (c === '\x7f' || c === '\x08') {
      ctx.dispatch({ type: 'delete-back' });
      i += 1;
      continue;
    }
    if (c === '\x01') {
      ctx.dispatch({ type: 'line-start' });
      i += 1;
      continue;
    }
    if (c === '\x05') {
      ctx.dispatch({ type: 'line-end' });
      i += 1;
      continue;
    }
    if (c === '\x0b') {
      ctx.dispatch({ type: 'kill-to-line-end' });
      i += 1;
      continue;
    }
    if (c === '\x15') {
      ctx.dispatch({ type: 'kill-to-line-start' });
      i += 1;
      continue;
    }
    if (c === '\x17') {
      ctx.dispatch({ type: 'delete-word-back' });
      i += 1;
      continue;
    }
    if (c === '\x19') {
      ctx.dispatch({ type: 'yank' });
      i += 1;
      continue;
    }
    if (c === '\t') {
      if (ctx.slashOpen) ctx.onSlashAccept();
      i += 1;
      continue;
    }
    if (c === '\x1b') {
      // Escape sequence. Need at least 2 more bytes for most; bail if
      // we don't have enough yet and let the caller buffer.
      const rest = chunk.slice(i);
      const matched = matchEscape(rest);
      if (!matched) {
        // Partial sequence — return remaining bytes so the next chunk
        // can complete the parse.
        remainder = rest;
        break;
      }
      const { action, len } = matched;
      if (action === 'esc-clear') {
        ctx.onCancel();
      } else if (action === 'up') {
        if (ctx.slashOpen) ctx.onSlashUp();
      } else if (action === 'down') {
        if (ctx.slashOpen) ctx.onSlashDown();
      } else if (action === 'left') {
        ctx.dispatch({ type: 'cursor-left' });
      } else if (action === 'right') {
        ctx.dispatch({ type: 'cursor-right' });
      } else if (action === 'word-left') {
        ctx.dispatch({ type: 'word-back' });
      } else if (action === 'word-right') {
        ctx.dispatch({ type: 'word-forward' });
      } else if (action === 'home') {
        ctx.dispatch({ type: 'line-start' });
      } else if (action === 'end') {
        ctx.dispatch({ type: 'line-end' });
      } else if (action === 'delete') {
        ctx.dispatch({ type: 'delete-forward' });
      } else if (action === 'word-back-delete') {
        ctx.dispatch({ type: 'delete-word-back' });
      } else if (action === 'alt-enter') {
        ctx.dispatch({ type: 'insert-newline', stripBackslashAtEnd: false });
      } else if (action === 'shift-tab') {
        ctx.onShiftTab?.();
      } else if (action === 'command-hotkey' && matched.letter) {
        ctx.commandHotkeys?.[matched.letter]?.();
      }
      i += len;
      continue;
    }
    // Printable byte — UTF-8 multi-byte chars stay intact in the string
    // because we converted the buffer with utf8 encoding.
    if (c >= ' ' || c === '\xa0') {
      ctx.dispatch({ type: 'insert', text: c });
      i += 1;
      continue;
    }
    // Caller-registered Ctrl+<letter> hotkey. Only reachable for bytes
    // the editor didn't already handle above.
    if (ctx.commandHotkeys) {
      const code = c.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        const letter = String.fromCharCode(code + 96);
        const handler = ctx.commandHotkeys[letter];
        if (handler) {
          handler();
          i += 1;
          continue;
        }
      }
    }
    // Unknown control byte; skip.
    i += 1;
  }
  return remainder;
}
