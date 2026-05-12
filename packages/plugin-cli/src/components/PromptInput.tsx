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
      // Backslash-Enter: line continuation. The user is composing a
      // multi-line prompt and wants a newline, not a submit. Strip the
      // trailing `\` and append a newline; keep the buffer open.
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
    if (key.backspace || key.delete) {
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
    // Accept single-key + paste. Newlines from paste are PRESERVED so a
    // multi-line clipboard payload comes in intact (the user can review
    // and submit). Tab/vertical-tab/etc. are still stripped because
    // terminals occasionally inject them around pasted content.
    if (!key.meta && !key.ctrl && !key.return && input) {
      const sanitized = input.replace(/[\r\t\v\f]/g, '');
      if (sanitized) {
        setBuffer((b) => b + sanitized);
        setSlashCursor(0);
      }
    }
  });

  const lines = buffer.length === 0 ? [''] : buffer.split('\n');
  const lastLineIdx = lines.length - 1;
  const showHint = buffer.length === 0 && placeholder;

  return (
    <Box flexDirection="column">
      {/* Wrap the input lines in horizontal rules so the buffer reads as
          a clear "input box" — Ink draws single-line borders on the top
          and bottom edges only via per-edge border flags. Color stays
          gray + dim so the chrome doesn't compete with the cursor. */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        borderDimColor
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
        paddingY={0}
      >
        {lines.map((line, i) => {
          const prefix =
            i === 0
              ? disabled
                ? '… '
                : '› '
              : '  ';
          const isCursorLine = i === lastLineIdx;
          return (
            <Box key={i}>
              <Text color={i === 0 ? (disabled ? 'gray' : 'green') : undefined}>{prefix}</Text>
              <Text>{line}</Text>
              {isCursorLine && showHint ? (
                <Text dimColor>{placeholder}</Text>
              ) : null}
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
