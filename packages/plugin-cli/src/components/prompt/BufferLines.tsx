import React from 'react';
import { Box, Text } from 'ink';

export const BufferLines: React.FC<{
  buffer: string;
  cursor: number;
  disabled: boolean;
  placeholder?: string;
}> = ({ buffer, cursor, disabled, placeholder }) => {
  const empty = buffer.length === 0;
  const lines = empty ? [''] : buffer.split('\n');
  const { lineIdx, colIdx } = locateCursor(buffer, cursor);
  // Each logical line is a horizontal Box: the prefix sits in a fixed
  // two-column gutter, and the wrappable content lives in a flexGrow
  // column to its right. Keeping the prefix OUT of the wrapping Text
  // avoids an off-by-one that Ink hits when wrap-ansi runs over a Text
  // whose first child is a styled sibling Text — there, the prefix's
  // visible width gets miscounted and short trailing words (e.g.
  // "takowe" → "takow"/"e") get hard-broken mid-word at the right edge.
  //
  // The cursor glyph (▌) stays as a colored child of the same content
  // Text so Ink's flatten-then-wrap pass keeps it in its true position
  // when content spills onto a new terminal row.
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
          <Box key={i} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={prefixColor}>{prefix}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text>
                {before}
                {isCursorLine ? <Text color="green">▌</Text> : null}
                {after}
                {showPlaceholder ? <Text dimColor>{placeholder}</Text> : null}
              </Text>
            </Box>
          </Box>
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
