import React from 'react';
import { Box, Text } from 'ink';
import { stripInline, type Align } from '@moxxy/chat-model/markdown';

/**
 * Render a GFM table. Computes per-column widths from the content,
 * scales them down proportionally if the row would overflow the
 * terminal (each cell still respects its declared alignment), and
 * draws a dim `─/┼` rule between header and body so the grid reads as
 * a unit. Cell contents go through `InlineText` so **bold** / `code`
 * / [links] inside cells render correctly.
 */
export const TableBlock: React.FC<{
  block: { header: ReadonlyArray<string>; aligns: ReadonlyArray<Align>; rows: ReadonlyArray<ReadonlyArray<string>> };
  suppressTopMargin: boolean;
}> = ({ block, suppressTopMargin }) => {
  const term = process.stdout.columns ?? 80;
  const numCols = block.header.length;
  if (numCols === 0) return null;
  // Sep is " │ " between cells — 3 cols per gap.
  const gap = 3;
  const totalGap = gap * Math.max(0, numCols - 1);

  // Natural widths from content (stripped of inline-md syntax so the
  // grid math doesn't get fooled by markers that won't render).
  const widths = block.header.map((h, ci) => {
    let max = visualLen(h);
    for (const row of block.rows) max = Math.max(max, visualLen(row[ci] ?? ''));
    return Math.max(3, max);
  });

  // Scale down proportionally if the natural row exceeds terminal.
  const naturalTotal = widths.reduce((a, b) => a + b, 0) + totalGap;
  const avail = Math.max(numCols * 4 + totalGap, term - 2);
  if (naturalTotal > avail) {
    const scale = (avail - totalGap) / (naturalTotal - totalGap);
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.max(3, Math.floor((widths[i] ?? 3) * scale));
    }
  }

  const aligns = block.header.map((_, ci) => block.aligns[ci] ?? 'left');
  return (
    <Box flexDirection="column" marginTop={suppressTopMargin ? 0 : 1}>
      <TableRow cells={block.header} widths={widths} aligns={aligns} bold />
      <TableRule widths={widths} />
      {block.rows.map((row, i) => (
        <TableRow key={i} cells={row} widths={widths} aligns={aligns} />
      ))}
    </Box>
  );
};

const TableRow: React.FC<{
  cells: ReadonlyArray<string>;
  widths: ReadonlyArray<number>;
  aligns: ReadonlyArray<Align>;
  bold?: boolean;
}> = ({ cells, widths, aligns, bold }) => (
  <Box>
    {widths.map((w, ci) => {
      const text = padCell(cells[ci] ?? '', w, aligns[ci] ?? 'left');
      return (
        <React.Fragment key={ci}>
          {ci > 0 ? <Text dimColor>{' │ '}</Text> : null}
          <Box width={w} flexShrink={0}>
            <Text bold={bold} wrap="truncate">
              {text}
            </Text>
          </Box>
        </React.Fragment>
      );
    })}
  </Box>
);

const TableRule: React.FC<{ widths: ReadonlyArray<number> }> = ({ widths }) => (
  <Text dimColor>{widths.map((w) => '─'.repeat(w)).join('─┼─')}</Text>
);

function padCell(value: string, width: number, align: Align): string {
  // Strip inline-markdown markers for layout sizing/padding; the actual
  // glyphs render through Text wrap="truncate" so visual width matches
  // padded width even when bold/italic markers got removed.
  const stripped = stripInline(value);
  const truncated = stripped.length > width ? stripped.slice(0, Math.max(0, width - 1)) + '…' : stripped;
  const slack = width - truncated.length;
  if (slack <= 0) return truncated;
  if (align === 'right') return ' '.repeat(slack) + truncated;
  if (align === 'center') {
    const left = Math.floor(slack / 2);
    return ' '.repeat(left) + truncated + ' '.repeat(slack - left);
  }
  return truncated + ' '.repeat(slack);
}

function visualLen(s: string): number {
  return stripInline(s).length;
}
