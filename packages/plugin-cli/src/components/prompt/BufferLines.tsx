import React from 'react';
import { Box, Text, useStdout } from 'ink';

const GUTTER = 2; // "› " / "  " prefix column

/**
 * Word-wrap one logical line to `width`, returning each visual row with the
 * char offset (into the logical line) where it starts — so the cursor can be
 * mapped back to a row + column. Breaks at the last space that fits; a single
 * word longer than `width` is hard-broken. An empty line yields one empty row.
 *
 * We wrap ourselves rather than letting Ink wrap the content `<Text>`: that
 * `<Text>` carries a styled cursor child, and Ink's flatten-then-wrap pass
 * miscounts width at the wrap column when a styled sibling is present, hard-
 * breaking a short trailing word mid-character (e.g. "mi" → "m" / "i"). Owning
 * the wrap keeps every row ≤ width, so Ink never re-wraps and never mis-breaks.
 */
export function wrapLogicalLine(line: string, width: number): Array<{ text: string; start: number }> {
  if (line.length === 0) return [{ text: '', start: 0 }];
  const w = Math.max(1, width);
  const rows: Array<{ text: string; start: number }> = [];
  let i = 0;
  while (i < line.length) {
    let end = Math.min(line.length, i + w);
    if (end < line.length) {
      // Cutting mid-line: prefer breaking after the last space that fits, so
      // whole words stay together. No space in range → hard-break a long word.
      const lastSpace = line.lastIndexOf(' ', end - 1);
      if (lastSpace >= i) end = lastSpace + 1;
    }
    rows.push({ text: line.slice(i, end), start: i });
    i = end;
  }
  return rows;
}

export const BufferLines: React.FC<{
  buffer: string;
  cursor: number;
  disabled: boolean;
  placeholder?: string;
  /**
   * Dimmed autocomplete preview rendered immediately after the cursor
   * when it sits at the very end of the buffer (e.g. the rest of a slash
   * command name plus its argument hint). Purely visual — never part of
   * `buffer`.
   */
  ghostSuffix?: string;
}> = ({ buffer, cursor, disabled, placeholder, ghostSuffix }) => {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const width = Math.max(8, cols - GUTTER);

  const empty = buffer.length === 0;
  const logicalLines = empty ? [''] : buffer.split('\n');
  const { lineIdx, colIdx } = locateCursor(buffer, cursor);

  // Flatten logical lines into visual rows, tagging each with its logical line.
  const rows: Array<{ text: string; start: number; line: number }> = [];
  logicalLines.forEach((line, li) => {
    for (const r of wrapLogicalLine(line, width)) rows.push({ ...r, line: li });
  });

  // Map the cursor (logical line + column) to a visual row + column. At a row
  // boundary the cursor belongs to the START of the next row (where typing
  // continues), except at the very end of a logical line.
  let cursorRow = -1;
  let cursorCol = 0;
  if (!disabled) {
    const lineRows = rows.filter((r) => r.line === lineIdx);
    for (let k = 0; k < lineRows.length; k += 1) {
      const r = lineRows[k]!;
      const last = k === lineRows.length - 1;
      const endExclusive = r.start + r.text.length;
      if (colIdx < endExclusive || (last && colIdx <= endExclusive)) {
        cursorRow = rows.indexOf(r);
        cursorCol = colIdx - r.start;
        break;
      }
    }
  }

  const atBufferEnd = cursor === buffer.length;

  return (
    <>
      {rows.map((row, idx) => {
        const prefix = idx === 0 ? (disabled ? '… ' : '› ') : '  ';
        const prefixColor = idx === 0 ? (disabled ? 'gray' : 'green') : undefined;
        const onCursorRow = idx === cursorRow;
        const showPlaceholder = idx === 0 && empty && !!placeholder;
        const showGhost = onCursorRow && atBufferEnd && !!ghostSuffix;

        return (
          <Box key={idx} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={prefixColor}>{prefix}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text>
                {onCursorRow ? (
                  <>
                    {row.text.slice(0, cursorCol)}
                    <Text inverse>{row.text.slice(cursorCol, cursorCol + 1) || ' '}</Text>
                    {row.text.slice(cursorCol + 1)}
                  </>
                ) : (
                  row.text
                )}
                {showGhost ? <Text dimColor>{ghostSuffix}</Text> : null}
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
