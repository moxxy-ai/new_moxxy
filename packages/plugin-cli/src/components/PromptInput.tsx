import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
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
  readonly slashCommands?: ReadonlyArray<SlashCommand>;
}

/**
 * Buffered input with a movable cursor + slash-command dropdown.
 *
 * Key handling is deliberately ordered: backspace/delete fire BEFORE
 * any cursor-motion or slash-dropdown logic. The previous version
 * had this ordering wrong and the cursor branch was eating
 * backspaces on some terminals.
 */
export const PromptInput: React.FC<PromptInputProps> = ({
  onSubmit,
  disabled,
  placeholder,
  slashCommands = BUILTIN_SLASH_COMMANDS,
}) => {
  const [buffer, setBuffer] = useState('');
  const [cursor, setCursor] = useState(0);
  const [slashCursor, setSlashCursor] = useState(0);

  const slashEligible = buffer.startsWith('/') && !buffer.includes('\n');
  const slashMatches: ReadonlyArray<SlashCommand> = slashEligible
    ? matchSlash(buffer, slashCommands)
    : [];

  const reset = (): void => {
    setBuffer('');
    setCursor(0);
    setSlashCursor(0);
  };

  useInput((input, key) => {
    if (disabled) return;

    // ── 1. Backspace ────────────────────────────────────────────────
    // Robust detection across terminal variants. Runs FIRST so no other
    // branch (cursor motion, slash dropdown, input acceptance) can
    // shadow it.
    const isBackspace =
      key.backspace ||
      input === '\x7f' ||
      input === '\x08' ||
      (key.ctrl && input === 'h');
    if (isBackspace) {
      if (cursor === 0) return;
      const pos = cursor;
      setBuffer((b) => b.slice(0, pos - 1) + b.slice(pos));
      setCursor((c) => Math.max(0, c - 1));
      setSlashCursor(0);
      return;
    }

    // ── 2. Forward-delete ───────────────────────────────────────────
    const isForwardDelete = key.delete || input === '\x1b[3~';
    if (isForwardDelete) {
      if (cursor >= buffer.length) return;
      const pos = cursor;
      setBuffer((b) => b.slice(0, pos) + b.slice(pos + 1));
      setSlashCursor(0);
      return;
    }

    // ── 3. Slash dropdown nav (up/down/tab) ─────────────────────────
    if (slashMatches.length > 0) {
      if (key.upArrow) {
        setSlashCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setSlashCursor((c) => Math.min(slashMatches.length - 1, c + 1));
        return;
      }
      if (key.tab) {
        const picked = slashMatches[Math.min(slashCursor, slashMatches.length - 1)];
        if (picked) {
          const next = `/${picked.name}`;
          setBuffer(next);
          setCursor(next.length);
          setSlashCursor(0);
        }
        return;
      }
    }

    // ── 4. Cursor motion ────────────────────────────────────────────
    // Option/Alt + Left/Right = word-jump (bash readline M-b / M-f).
    // Plain Left/Right = one char. Ctrl-A / Ctrl-E = line start / end.
    if (key.leftArrow) {
      if (key.meta) setCursor((c) => moveWordBackward(buffer, c));
      else setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      if (key.meta) setCursor((c) => moveWordForward(buffer, c));
      else setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }
    if (key.ctrl && input === 'a') {
      setCursor((c) => lineStart(buffer, c));
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursor((c) => lineEnd(buffer, c));
      return;
    }

    // ── 5. Return: submit or line continuation ─────────────────────
    if (key.return) {
      if (cursor > 0 && buffer[cursor - 1] === '\\') {
        // Backslash-Enter: drop the trailing `\`, insert newline,
        // keep buffer open. Cursor stays at the inserted newline +1.
        const pos = cursor;
        setBuffer((b) => b.slice(0, pos - 1) + '\n' + b.slice(pos));
        return;
      }
      const trimmed = buffer.trim();
      reset();
      if (trimmed) onSubmit(trimmed);
      return;
    }

    // ── 6. Escape / exit ───────────────────────────────────────────
    if (key.escape) {
      reset();
      return;
    }
    if (key.ctrl && input === 'c') {
      process.exit(0);
    }

    // ── 7. Printable input acceptance ──────────────────────────────
    // Negation guards stop us from re-inserting control bytes that
    // Ink sometimes smuggles through alongside the key flag.
    if (
      !key.meta &&
      !key.ctrl &&
      !key.return &&
      !key.backspace &&
      !key.delete &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.escape &&
      !key.tab &&
      input
    ) {
      const sanitized = input.replace(/[\r\t\v\f\x08\x7f]/g, '');
      if (sanitized) {
        const pos = cursor;
        setBuffer((b) => b.slice(0, pos) + sanitized + b.slice(pos));
        setCursor((c) => c + sanitized.length);
        setSlashCursor(0);
      }
    }
  });

  // Render the buffer line-by-line, splicing in an inverse-video cursor
  // glyph at the current position. The cursor is visible even when the
  // buffer is empty (sits on the first column).
  const lines = buffer.length === 0 ? [''] : buffer.split('\n');
  const isEmpty = buffer.length === 0;
  let consumed = 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        borderDimColor
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
      >
        {lines.map((line, i) => {
          const lineStartIdx = consumed;
          const cursorInLine = cursor - lineStartIdx;
          const inThisLine = cursorInLine >= 0 && cursorInLine <= line.length;
          consumed += line.length + 1;

          const prefix = i === 0 ? (disabled ? '… ' : '› ') : '  ';
          const prefixColor = i === 0 ? (disabled ? 'gray' : 'green') : undefined;

          if (isEmpty && i === 0) {
            return (
              <Box key={i}>
                <Text color={prefixColor}>{prefix}</Text>
                {!disabled ? <Text inverse>{' '}</Text> : null}
                {placeholder ? <Text dimColor>{placeholder}</Text> : null}
              </Box>
            );
          }
          if (!inThisLine || disabled) {
            return (
              <Box key={i}>
                <Text color={prefixColor}>{prefix}</Text>
                <Text>{line}</Text>
              </Box>
            );
          }
          const before = line.slice(0, cursorInLine);
          const atChar = line[cursorInLine] ?? ' ';
          const after = line.slice(cursorInLine + 1);
          return (
            <Box key={i}>
              <Text color={prefixColor}>{prefix}</Text>
              <Text>{before}</Text>
              <Text inverse>{atChar}</Text>
              <Text>{after}</Text>
            </Box>
          );
        })}
      </Box>
      {slashMatches.length > 0 ? (
        <SlashSuggestions
          matches={slashMatches}
          cursor={Math.min(slashCursor, slashMatches.length - 1)}
        />
      ) : null}
    </Box>
  );
};

// ── Word-jump helpers (bash readline semantics) ─────────────────────
// Forward: skip whitespace, then skip non-whitespace.
// Backward: mirror.

function moveWordForward(buf: string, pos: number): number {
  let i = pos;
  while (i < buf.length && /\s/.test(buf[i]!)) i++;
  while (i < buf.length && !/\s/.test(buf[i]!)) i++;
  return i;
}

function moveWordBackward(buf: string, pos: number): number {
  let i = pos;
  while (i > 0 && /\s/.test(buf[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(buf[i - 1]!)) i--;
  return i;
}

function lineStart(buf: string, pos: number): number {
  const nl = buf.lastIndexOf('\n', pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

function lineEnd(buf: string, pos: number): number {
  const nl = buf.indexOf('\n', pos);
  return nl === -1 ? buf.length : nl;
}
