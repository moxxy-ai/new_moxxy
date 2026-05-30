import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Box, useApp, useStdin } from 'ink';
import {
  BUILTIN_SLASH_COMMANDS,
  matchSlash,
  SlashSuggestions,
  type SlashCommand,
} from './SlashCommands.js';
import { BufferLines } from './prompt/BufferLines.js';
import {
  nextExternalInsertAction,
  type ExternalInsert,
} from './prompt/external-insert.js';
import { INITIAL, reducer, type Action, type State } from './prompt/reducer.js';
import { parseInputChunk } from './prompt/parse-input.js';

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
  /**
   * Map of `Ctrl+<letter>` hotkeys to react to inside the input. Lets
   * the session wire force-send / drop / live-block toggle without
   * relying on Ink's `useInput`, which doesn't receive bytes once
   * PromptInput's raw-stdin listener flips the stream to flowing mode.
   * Keys are single lowercase letters; collisions with editor keys
   * (a/c/e/h/j/k/u/w/y) silently no-op.
   */
  readonly commandHotkeys?: Record<string, () => void>;
  /**
   * Shift+Tab handler. Wired to mode-cycling by the session — pressing
   * Shift+Tab in the input advances to the next registered mode. Routed
   * through the raw-stdin parser for the same reason as `commandHotkeys`.
   */
  readonly onShiftTab?: () => void;
  readonly externalInsert?: ExternalInsert;
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
 *   Ctrl+C               exit TUI
 *   Paste                bracketed paste inserts the payload verbatim
 */
export const PromptInput: React.FC<PromptInputProps> = ({
  onSubmit,
  disabled,
  placeholder,
  slashCommands = BUILTIN_SLASH_COMMANDS,
  onPasteText,
  commandHotkeys,
  onShiftTab,
  externalInsert,
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

  // Dimmed autocomplete preview shown inline after the cursor: the rest
  // of the focused command's name plus its argument hint. Only while the
  // user is still typing the NAME (no whitespace yet), the cursor sits at
  // the buffer end, and the focused match's name actually extends what was
  // typed (skip alias-only matches, where a completion would read wrong).
  const ghostSuffix = ((): string => {
    if (!slashEligible || state.cursor !== state.buffer.length) return '';
    const needle = state.buffer.slice(1);
    if (needle === '' || /\s/.test(needle)) return '';
    const focused = slashMatches[Math.min(slashCursor, slashMatches.length - 1)];
    if (!focused || !focused.name.toLowerCase().startsWith(needle.toLowerCase())) return '';
    const restName = focused.name.slice(needle.length);
    const hint = focused.argumentHint ? ` ${focused.argumentHint}` : '';
    return restName + hint;
  })();

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
  const commandHotkeysRef = useRef(commandHotkeys);
  commandHotkeysRef.current = commandHotkeys;
  const onShiftTabRef = useRef(onShiftTab);
  onShiftTabRef.current = onShiftTab;
  const lastExternalInsertIdRef = useRef<number | null>(null);

  useEffect(() => {
    const decision = nextExternalInsertAction(lastExternalInsertIdRef.current, externalInsert);
    lastExternalInsertIdRef.current = decision.lastId;
    if (decision.action) dispatch(decision.action);
  }, [externalInsert]);

  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { exit } = useApp();

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
      onExit: exit,
      onShiftTab: () => onShiftTabRef.current?.(),
      onPasteText: (text: string) => onPasteTextRef.current?.(text) ?? text,
      slashOpen: false,
      bufferRef: { current: { buffer: '', cursor: 0 } },
      commandHotkeys: commandHotkeysRef.current,
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
      // Refresh the hotkey map every chunk so React state captured by
      // the parent (e.g. queue actions whose closure changes on every
      // render) sees the latest references.
      parseCtx.commandHotkeys = commandHotkeysRef.current;
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
  }, [stdin, isRawModeSupported, setRawMode, handleSubmit, handleCancel, handleSlashAccept, exit]);

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
        ghostSuffix={ghostSuffix}
      />
    </Box>
  );
};
