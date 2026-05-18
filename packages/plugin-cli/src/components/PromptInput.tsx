import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Box, Text, useStdin } from 'ink';
import {
  BUILTIN_SLASH_COMMANDS,
  matchSlash,
  SlashSuggestions,
  type SlashCommand,
} from './SlashCommands.js';

export interface PromptInputProps {
  readonly onSubmit: (value: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /**
   * Slash-command catalog the autocomplete dropdown searches against.
   * Defaults to BUILTIN_SLASH_COMMANDS — pass a custom list to extend.
   */
  readonly slashCommands?: ReadonlyArray<SlashCommand>;
  /**
   * Synchronous transform for bracketed-paste payloads. Receives the
   * full pasted text and returns the text actually inserted into the
   * buffer. Used to swap image file paths (drag-drop, "Copy as Path")
   * for `[Image #N]` placeholders while side-loading the bytes.
   */
  readonly onPasteText?: (text: string) => string;
}

/**
 * Rich text input with a movable cursor, word navigation, bracketed
 * paste, and an internal kill ring. Bypasses Ink's `useInput` and reads
 * raw escape sequences directly from `process.stdin` — gives us precise
 * control over arrow keys, Alt+arrow word jumps, Home/End, Ctrl-key
 * editing, and multi-byte paste payloads.
 *
 * Keybindings:
 *   Left / Right         move cursor one character
 *   Alt+Left / Alt+Right move cursor one word
 *   Ctrl+A / Ctrl+E      jump to line start / end (within current line)
 *   Home / End           same as Ctrl+A / Ctrl+E
 *   Backspace            delete char before cursor (incl. across newlines)
 *   Delete               delete char after cursor
 *   Alt+Backspace        delete word before cursor
 *   Ctrl+W               delete word before cursor (bash-style)
 *   Ctrl+K               kill text from cursor to end of line → kill ring
 *   Ctrl+U               kill text from line start to cursor → kill ring
 *   Ctrl+Y               yank kill ring at cursor
 *   Enter                submit
 *   Alt+Enter            insert newline
 *   Backslash + Enter    insert newline (legacy)
 *   Tab                  accept current slash suggestion
 *   Up / Down            navigate slash suggestions (when dropdown is open)
 *   Esc                  clear input
 *   Ctrl+C               exit process
 *   Paste                bracketed paste inserts the payload verbatim
 */

interface State {
  buffer: string;
  cursor: number;
  killBuffer: string;
  inPaste: boolean;
  pasteBuffer: string;
}

type Action =
  | { type: 'insert'; text: string }
  | { type: 'insert-newline'; stripBackslashAtEnd: boolean }
  | { type: 'delete-back' }
  | { type: 'delete-forward' }
  | { type: 'delete-word-back' }
  | { type: 'cursor-left' }
  | { type: 'cursor-right' }
  | { type: 'word-back' }
  | { type: 'word-forward' }
  | { type: 'line-start' }
  | { type: 'line-end' }
  | { type: 'kill-to-line-end' }
  | { type: 'kill-to-line-start' }
  | { type: 'yank' }
  | { type: 'reset' }
  | { type: 'set'; buffer: string; cursor: number }
  | { type: 'paste-start' }
  | { type: 'paste-end'; overrideText?: string }
  | { type: 'paste-append'; data: string };

const INITIAL: State = {
  buffer: '',
  cursor: 0,
  killBuffer: '',
  inPaste: false,
  pasteBuffer: '',
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'insert': {
      const next = state.buffer.slice(0, state.cursor) + action.text + state.buffer.slice(state.cursor);
      return { ...state, buffer: next, cursor: state.cursor + action.text.length };
    }
    case 'insert-newline': {
      // Insert a newline at the cursor. If stripBackslashAtEnd is true
      // AND the buffer ends with `\` AND the cursor is at the end,
      // strip the trailing backslash first (legacy line-continuation
      // syntax). Atomic — one reducer pass, no risk of half-updated
      // state between dispatches.
      const stripping =
        action.stripBackslashAtEnd &&
        state.buffer.endsWith('\\') &&
        state.cursor === state.buffer.length;
      const buf = stripping ? state.buffer.slice(0, -1) : state.buffer;
      const cur = stripping ? state.cursor - 1 : state.cursor;
      const next = buf.slice(0, cur) + '\n' + buf.slice(cur);
      return { ...state, buffer: next, cursor: cur + 1 };
    }
    case 'delete-back': {
      if (state.cursor === 0) return state;
      const next = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
      return { ...state, buffer: next, cursor: state.cursor - 1 };
    }
    case 'delete-forward': {
      if (state.cursor >= state.buffer.length) return state;
      const next = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
      return { ...state, buffer: next };
    }
    case 'delete-word-back': {
      if (state.cursor === 0) return state;
      const start = wordBackPos(state.buffer, state.cursor);
      const killed = state.buffer.slice(start, state.cursor);
      const next = state.buffer.slice(0, start) + state.buffer.slice(state.cursor);
      return { ...state, buffer: next, cursor: start, killBuffer: killed };
    }
    case 'cursor-left':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'cursor-right':
      return { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) };
    case 'word-back':
      return { ...state, cursor: wordBackPos(state.buffer, state.cursor) };
    case 'word-forward':
      return { ...state, cursor: wordForwardPos(state.buffer, state.cursor) };
    case 'line-start':
      return { ...state, cursor: lineStart(state.buffer, state.cursor) };
    case 'line-end':
      return { ...state, cursor: lineEnd(state.buffer, state.cursor) };
    case 'kill-to-line-end': {
      const end = lineEnd(state.buffer, state.cursor);
      const killed = state.buffer.slice(state.cursor, end);
      const next = state.buffer.slice(0, state.cursor) + state.buffer.slice(end);
      return { ...state, buffer: next, killBuffer: killed };
    }
    case 'kill-to-line-start': {
      const start = lineStart(state.buffer, state.cursor);
      const killed = state.buffer.slice(start, state.cursor);
      const next = state.buffer.slice(0, start) + state.buffer.slice(state.cursor);
      return { ...state, buffer: next, cursor: start, killBuffer: killed };
    }
    case 'yank': {
      if (!state.killBuffer) return state;
      const next =
        state.buffer.slice(0, state.cursor) + state.killBuffer + state.buffer.slice(state.cursor);
      return { ...state, buffer: next, cursor: state.cursor + state.killBuffer.length };
    }
    case 'reset':
      return { ...INITIAL, killBuffer: state.killBuffer };
    case 'set':
      return { ...state, buffer: action.buffer, cursor: clamp(action.cursor, 0, action.buffer.length) };
    case 'paste-start':
      return { ...state, inPaste: true, pasteBuffer: '' };
    case 'paste-end': {
      const text = action.overrideText !== undefined ? action.overrideText : state.pasteBuffer;
      const next = state.buffer.slice(0, state.cursor) + text + state.buffer.slice(state.cursor);
      return { ...state, buffer: next, cursor: state.cursor + text.length, inPaste: false, pasteBuffer: '' };
    }
    case 'paste-append':
      return { ...state, pasteBuffer: state.pasteBuffer + action.data };
    default:
      return state;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function wordBackPos(buffer: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(buffer[i - 1]!)) i -= 1;
  while (i > 0 && isWordChar(buffer[i - 1]!)) i -= 1;
  return i;
}

function wordForwardPos(buffer: string, cursor: number): number {
  let i = cursor;
  while (i < buffer.length && !isWordChar(buffer[i]!)) i += 1;
  while (i < buffer.length && isWordChar(buffer[i]!)) i += 1;
  return i;
}

function lineStart(buffer: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && buffer[i - 1] !== '\n') i -= 1;
  return i;
}

function lineEnd(buffer: string, cursor: number): number {
  let i = cursor;
  while (i < buffer.length && buffer[i] !== '\n') i += 1;
  return i;
}

/**
 * Translate raw stdin bytes into reducer actions. Buffer the latest
 * chunk locally so multi-byte escape sequences that arrive split across
 * `data` events still parse. Returns the consumed length so the caller
 * can keep any partial trailing sequence for the next chunk.
 */
function parseInputChunk(
  chunk: string,
  ctx: {
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
    onPasteText?: (text: string) => string;
    slashOpen: boolean;
    bufferRef: { current: { buffer: string; cursor: number } };
  },
): string {
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
        const data = chunk.slice(i).replace(/\r/g, '\n');
        ctx.pasteAccum.text += data;
        ctx.dispatch({ type: 'paste-append', data });
        return '';
      }
      const inner = chunk.slice(i, endIdx).replace(/\r/g, '\n');
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
      // Ctrl+C → process exit.
      process.exit(0);
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
    // Unknown control byte; skip.
    i += 1;
  }
  return remainder;
}

interface EscapeMatch {
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
    | 'alt-enter';
  len: number;
}

function matchEscape(rest: string): EscapeMatch | null {
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

export const PromptInput: React.FC<PromptInputProps> = ({
  onSubmit,
  disabled,
  placeholder,
  slashCommands = BUILTIN_SLASH_COMMANDS,
  onPasteText,
}) => {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [slashCursor, setSlashCursor] = React.useState(0);

  // Refs so the data handler (registered once on mount) reads the
  // current buffer/cursor without re-subscribing on every keystroke.
  const stateRef = useRef(state);
  stateRef.current = state;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const slashEligible = state.buffer.startsWith('/') && !state.buffer.includes('\n');
  const slashMatches: ReadonlyArray<SlashCommand> = slashEligible
    ? matchSlash(state.buffer, slashCommands)
    : [];
  const slashMatchesRef = useRef(slashMatches);
  slashMatchesRef.current = slashMatches;
  const slashCursorRef = useRef(slashCursor);
  slashCursorRef.current = slashCursor;

  const handleSubmit = useCallback(() => {
    const cur = stateRef.current;
    const trimmed = cur.buffer.trim();
    if (!trimmed) return;
    dispatch({ type: 'reset' });
    setSlashCursor(0);
    onSubmitRef.current(trimmed);
  }, []);

  const handleCancel = useCallback(() => {
    dispatch({ type: 'reset' });
    setSlashCursor(0);
  }, []);

  const handleSlashAccept = useCallback(() => {
    const matches = slashMatchesRef.current;
    if (matches.length === 0) return;
    const picked = matches[Math.min(slashCursorRef.current, matches.length - 1)];
    if (picked) {
      dispatch({ type: 'set', buffer: `/${picked.name}`, cursor: picked.name.length + 1 });
      setSlashCursor(0);
    }
  }, []);

  const onPasteTextRef = useRef(onPasteText);
  onPasteTextRef.current = onPasteText;

  const { stdin, setRawMode, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (!isRawModeSupported) return;
    setRawMode(true);
    // Enable bracketed paste so multi-line clipboard payloads arrive as
    // a single delimited block — without this, terminals submit on the
    // first newline inside the pasted text.
    process.stdout.write('\x1b[?2004h');
    // Enable kitty keyboard protocol (level 1: disambiguate escape
    // codes). Lets terminals that support it (kitty, iTerm2, wezterm,
    // ghostty, alacritty…) encode Shift+Enter as `\x1b[13;2u` instead
    // of indistinguishable plain `\r`. Terminals that don't support it
    // ignore the escape silently — Shift+Enter will still submit (same
    // as before) in those, and users can use `\` + Enter as a fallback.
    process.stdout.write('\x1b[>1u');

    let remainder = '';
    const parseCtx: Parameters<typeof parseInputChunk>[1] = {
      inPaste: false,
      pasteAccum: { text: '' },
      dispatch,
      onSubmit: handleSubmit,
      onCancel: handleCancel,
      onSlashUp: () => setSlashCursor((c) => Math.max(0, c - 1)),
      onSlashDown: () => setSlashCursor((c) => Math.min(slashMatchesRef.current.length - 1, c + 1)),
      onSlashAccept: handleSlashAccept,
      onPasteText: (text: string) => onPasteTextRef.current?.(text) ?? text,
      slashOpen: false,
      bufferRef: { current: { buffer: '', cursor: 0 } },
    };

    const onData = (data: Buffer): void => {
      if (disabledRef.current) return;
      // Snapshot canonical state at start of chunk, then mirror every
      // dispatched action locally so subsequent checks within this
      // chunk (e.g. "does buffer end with `\\` now?") see fresh state.
      // Two dispatches inside a non-React event aren't seen atomically
      // by later parser checks without this — the React reducer
      // applies them eventually but the parser's view stays stale.
      let local: State = { ...stateRef.current };
      const wrappedDispatch = (action: Action): void => {
        local = reducer(local, action);
        dispatch(action);
      };
      parseCtx.dispatch = wrappedDispatch;
      parseCtx.slashOpen = slashMatchesRef.current.length > 0;
      parseCtx.bufferRef = {
        get current(): { buffer: string; cursor: number } {
          return { buffer: local.buffer, cursor: local.cursor };
        },
      } as { current: { buffer: string; cursor: number } };
      parseCtx.inPaste = local.inPaste;
      const chunk = remainder + data.toString('utf8');
      remainder = parseInputChunk(chunk, parseCtx);
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      process.stdout.write('\x1b[?2004l');
      // Pop the kitty keyboard-protocol flag we pushed on mount.
      process.stdout.write('\x1b[<u');
      // Leave rawMode toggled — Ink owns the lifecycle; other
      // components might still need raw input.
    };
  }, [stdin, isRawModeSupported, setRawMode, handleSubmit, handleCancel, handleSlashAccept]);

  // Render: place an inverse-styled "cursor cell" at state.cursor.
  // Split buffer into before / atCursor / after segments, then walk
  // through each line so multi-line input renders correctly. The
  // rounded border is owned by `<InputBox>` so this stays borderless.
  // Slash suggestions render right above the buffer so they appear
  // inside the InputBox border, dropdown-style.
  return (
    <Box flexDirection="column">
      {slashMatches.length > 0 ? (
        <SlashSuggestions
          matches={slashMatches}
          cursor={Math.min(slashCursor, slashMatches.length - 1)}
        />
      ) : null}
      <BufferLines
        buffer={state.buffer}
        cursor={state.cursor}
        disabled={!!disabled}
        placeholder={placeholder}
      />
    </Box>
  );
};

const BufferLines: React.FC<{
  buffer: string;
  cursor: number;
  disabled: boolean;
  placeholder?: string;
}> = ({ buffer, cursor, disabled, placeholder }) => {
  const empty = buffer.length === 0;
  const lines = empty ? [''] : buffer.split('\n');
  const { lineIdx, colIdx } = locateCursor(buffer, cursor);
  // Each logical line is rendered as ONE <Text>. The cursor glyph (▌) is
  // a nested colored child of that same Text — Ink squashes everything
  // into a single string before measuring/wrapping, so wrap-ansi keeps
  // the cursor in its true position when a long line spills to the next
  // terminal row. Sibling Text nodes get their own yoga rects: a long
  // first sibling that wrapped to two rows would still place the next
  // sibling at (x=width, y=0) — i.e. the right edge of the FIRST row —
  // which produced the "cursor stuck on line 1" symptom.
  return (
    <>
      {lines.map((line, i) => {
        const prefix = i === 0 ? (disabled ? '… ' : '› ') : '  ';
        const prefixColor = i === 0 ? (disabled ? 'gray' : 'green') : undefined;
        const isCursorLine = i === lineIdx && !disabled;
        const before = isCursorLine ? line.slice(0, colIdx) : line;
        const after = isCursorLine ? line.slice(colIdx) : '';
        const showPlaceholder = i === lines.length - 1 && empty && !!placeholder;
        return (
          <Text key={i}>
            <Text color={prefixColor}>{prefix}</Text>
            {before}
            {isCursorLine ? <Text color="green">▌</Text> : null}
            {after}
            {showPlaceholder ? <Text dimColor>{placeholder}</Text> : null}
          </Text>
        );
      })}
    </>
  );
};

function locateCursor(buffer: string, cursor: number): { lineIdx: number; colIdx: number } {
  let lineIdx = 0;
  let lineStart = 0;
  for (let i = 0; i < cursor; i += 1) {
    if (buffer[i] === '\n') {
      lineIdx += 1;
      lineStart = i + 1;
    }
  }
  return { lineIdx, colIdx: cursor - lineStart };
}
