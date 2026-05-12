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

  const slashMatches: ReadonlyArray<SlashCommand> = buffer.startsWith('/')
    ? matchSlash(buffer, slashCommands)
    : [];

  useInput((input, key) => {
    if (disabled) return;

    // Arrow keys + tab inside the slash dropdown pre-empt buffer mutations.
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
    // Accept paste (multi-character input). Strip control whitespace that
    // terminals append (newlines, tabs) so the user doesn't have to clean
    // up after pasting from their clipboard.
    if (!key.meta && !key.ctrl && !key.return && input) {
      const sanitized = input.replace(/[\r\n\t\v\f]/g, '');
      if (sanitized) {
        setBuffer((b) => b + sanitized);
        setSlashCursor(0);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={disabled ? 'gray' : 'green'}>{disabled ? '… ' : '› '}</Text>
        <Text>{buffer || (placeholder ? <Text dimColor>{placeholder}</Text> : '')}</Text>
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
