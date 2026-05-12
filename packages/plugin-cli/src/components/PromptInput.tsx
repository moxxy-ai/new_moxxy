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
  /**
   * Slash-command catalog the autocomplete dropdown searches against.
   * Defaults to BUILTIN_SLASH_COMMANDS — pass a custom list to extend.
   */
  readonly slashCommands?: ReadonlyArray<SlashCommand>;
}

/**
 * Append-only buffer with a slash-command dropdown. No cursor / no
 * word-jump — the previous cursor-based implementation interacted
 * badly with backspace detection across terminal/keyboard variants
 * and left users unable to delete input. Keeping it simple: type
 * goes to the end, backspace removes from the end.
 */
export const PromptInput: React.FC<PromptInputProps> = ({
  onSubmit,
  disabled,
  placeholder,
  slashCommands = BUILTIN_SLASH_COMMANDS,
}) => {
  const [buffer, setBuffer] = useState('');
  const [slashCursor, setSlashCursor] = useState(0);

  // The slash dropdown only opens on a SINGLE-LINE buffer that starts
  // with `/` — multi-line composing modes shouldn't keep popping the
  // command picker as the user types prose.
  const slashEligible = buffer.startsWith('/') && !buffer.includes('\n');
  const slashMatches: ReadonlyArray<SlashCommand> = slashEligible
    ? matchSlash(buffer, slashCommands)
    : [];

  useInput((input, key) => {
    if (disabled) return;

    // Slash dropdown navigation (up/down/tab) takes precedence over
    // plain-buffer keys when the dropdown is open.
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
          setBuffer(`/${picked.name}`);
          setSlashCursor(0);
        }
        return;
      }
    }

    if (key.return) {
      // Backslash-Enter: line continuation. Trailing `\` is consumed,
      // a newline is appended, and the buffer stays open for more input.
      if (buffer.endsWith('\\')) {
        setBuffer((b) => b.slice(0, -1) + '\n');
        setSlashCursor(0);
        return;
      }
      const trimmed = buffer.trim();
      setBuffer('');
      setSlashCursor(0);
      if (trimmed) onSubmit(trimmed);
      return;
    }

    // Robust backspace detection. Different terminals route the key
    // differently — accept any of: Ink's key.backspace flag, the raw
    // DEL (\x7f) byte, the raw BS (\x08) byte, or Ctrl+H bindings.
    const isBackspace =
      key.backspace ||
      input === '\x7f' ||
      input === '\x08' ||
      (key.ctrl && input === 'h');
    if (isBackspace) {
      setBuffer((b) => b.slice(0, -1));
      setSlashCursor(0);
      return;
    }

    if (key.delete) {
      // No cursor means forward-delete is the same as backspace here —
      // remove the trailing character.
      setBuffer((b) => b.slice(0, -1));
      setSlashCursor(0);
      return;
    }
    if (key.escape) {
      setBuffer('');
      setSlashCursor(0);
      return;
    }
    if (key.ctrl && input === 'c') {
      process.exit(0);
    }
    // Accept printable input (single char or pasted block). Newlines
    // preserved (so a multi-line paste survives); strip control bytes
    // and the DEL/BS bytes that some terminals smuggle through with a
    // non-empty `input` alongside the key flag.
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
        setBuffer((b) => b + sanitized);
        setSlashCursor(0);
      }
    }
  });

  const lines = buffer.length === 0 ? [''] : buffer.split('\n');
  const showHint = buffer.length === 0 && placeholder;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Horizontal rules above + below the buffer so the input region
          reads as one distinct box against the chat scrollback. Color
          stays gray + dim so the chrome doesn't compete with content. */}
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
          const prefix = i === 0 ? (disabled ? '… ' : '› ') : '  ';
          const prefixColor = i === 0 ? (disabled ? 'gray' : 'green') : undefined;
          const isLast = i === lines.length - 1;
          return (
            <Box key={i}>
              <Text color={prefixColor}>{prefix}</Text>
              <Text>{line}</Text>
              {isLast && showHint ? <Text dimColor>{placeholder}</Text> : null}
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
