import React from 'react';
import { Box, Text } from 'ink';

/**
 * Minimal terminal-friendly markdown renderer. Handles the subset the
 * assistant produces in chat replies — headings, bullet lists, numbered
 * lists, fenced code blocks, inline code, bold, italic, and links.
 * Anything else falls through as plain text.
 *
 * Zero dependencies (no `marked` / `markdown-it`); ~200 lines of pure
 * regex transforms. Good-enough is the right bar here — the chat is
 * ephemeral, the user will catch any rendering edge case visually.
 */
export interface MarkdownProps {
  readonly content: string;
  /**
   * When true, the first block's `marginTop` is suppressed. Used by
   * AssistantBlock so the response body sits flush with the bullet on
   * the same row, even when the body starts with a heading (which
   * would otherwise push the text down one line).
   */
  readonly firstBlockTight?: boolean;
}

export const Markdown: React.FC<MarkdownProps> = ({ content, firstBlockTight }) => {
  const blocks = parseBlocks(content);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} suppressTopMargin={firstBlockTight && i === 0} />
      ))}
    </Box>
  );
};

type Align = 'left' | 'center' | 'right';

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: ReadonlyArray<string> }
  | { kind: 'code'; lang: string | null; body: string }
  | {
      kind: 'table';
      header: ReadonlyArray<string>;
      aligns: ReadonlyArray<Align>;
      rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { kind: 'blank' };

function parseBlocks(src: string): Block[] {
  const lines = normalizeInlineTables(src).split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: 'code', lang, body: body.join('\n') });
      continue;
    }

    // GFM table: a row starting with `|` and at least one more `|`,
    // followed by a separator row like `|---|---:|:---:|`. We require
    // the separator to distinguish real tables from prose that
    // happens to contain pipe characters.
    if (line.trim().startsWith('|') && i + 1 < lines.length) {
      const sep = lines[i + 1]!;
      if (isTableSeparator(sep)) {
        const header = parseTableCells(line);
        const aligns = parseTableAligns(sep);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i]!.trim().startsWith('|')) {
          const cells = parseTableCells(lines[i]!);
          if (cells.length === 0) break;
          // Pad / clamp to header length so the grid stays rectangular.
          while (cells.length < header.length) cells.push('');
          rows.push(cells.slice(0, header.length));
          i++;
        }
        blocks.push({ kind: 'table', header, aligns, rows });
        continue;
      }
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(1, heading[1]!.length)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, text: heading[2]!.trim() });
      i++;
      continue;
    }

    // List (bullet or numbered) — consume consecutive list lines
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+\.\s+(.*)$/.exec(lines[i]!)
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(m[1]!.trim());
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      blocks.push({ kind: 'blank' });
      i++;
      continue;
    }

    // Otherwise: paragraph — gather until blank/structural line
    const paraLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      const next = lines[i]!;
      if (
        /^```/.test(next) ||
        /^#{1,6}\s+/.test(next) ||
        /^\s*[-*+]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next)
      ) {
        break;
      }
      // Mid-paragraph table: pipe row followed by a separator row.
      // Stop the paragraph here so the table check at the top of the
      // outer loop picks it up.
      if (
        next.trim().startsWith('|') &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1]!)
      ) {
        break;
      }
      paraLines.push(next);
      i++;
    }
    blocks.push({ kind: 'paragraph', text: paraLines.join(' ') });
  }
  return blocks;
}

const BlockNode: React.FC<{ block: Block; suppressTopMargin?: boolean }> = ({
  block,
  suppressTopMargin,
}) => {
  switch (block.kind) {
    case 'heading': {
      const color = block.level === 1 ? 'cyan' : block.level === 2 ? 'magenta' : 'yellow';
      const mt = suppressTopMargin ? 0 : block.level <= 2 ? 1 : 0;
      return (
        <Box marginTop={mt}>
          <Text bold color={color}>{'#'.repeat(block.level)} </Text>
          <Text bold color={color}>{block.text}</Text>
        </Box>
      );
    }
    case 'paragraph':
      return (
        <Box>
          <InlineText text={block.text} />
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i}>
              <Text dimColor>{block.ordered ? `${i + 1}. ` : '• '}</Text>
              <InlineText text={item} />
            </Box>
          ))}
        </Box>
      );
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" borderDimColor paddingX={1}>
          {block.lang ? (
            <Text dimColor italic>{block.lang}</Text>
          ) : null}
          {block.body.split('\n').map((line, i) => (
            <Text key={i} color="cyan">{line}</Text>
          ))}
        </Box>
      );
    case 'table':
      return <TableBlock block={block} suppressTopMargin={!!suppressTopMargin} />;
    case 'blank':
      return <Text> </Text>;
  }
};

/**
 * Render a GFM table. Computes per-column widths from the content,
 * scales them down proportionally if the row would overflow the
 * terminal (each cell still respects its declared alignment), and
 * draws a dim `─/┼` rule between header and body so the grid reads as
 * a unit. Cell contents go through `InlineText` so **bold** / `code`
 * / [links] inside cells render correctly.
 */
const TableBlock: React.FC<{
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

function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Some models emit GFM tables on a single line — header, separator,
 * and every row glued together with `" | | "` (closing-pipe space
 * opening-pipe of the next row) instead of newlines. The block parser
 * can't pick that up because it scans line-by-line, so explode the
 * compressed form into proper rows before parsing.
 *
 * Detection requires BOTH a separator pattern (`|---|`) AND at least
 * one `" | | "` row boundary on the same line, so legitimate prose
 * with stray pipe characters never triggers the split.
 */
function normalizeInlineTables(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) return line;
      const hasSeparator = /\|\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|/.test(trimmed);
      const hasRowBoundary = / \| \|/.test(trimmed);
      if (!hasSeparator || !hasRowBoundary) return line;
      return trimmed.replace(/ \| \|/g, ' |\n|');
    })
    .join('\n');
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  // Reject lines that contain non-pipe/dash/colon/space content.
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(trimmed);
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((s) => s.trim());
}

function parseTableAligns(sep: string): Align[] {
  const cells = sep.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

/**
 * Inline-span renderer: handles `code`, **bold**, *italic*, and [text](url)
 * within a paragraph. Tokenizes once with a single combined regex.
 */
const InlineText: React.FC<{ text: string }> = ({ text }) => {
  const tokens = tokenizeInline(text);
  return (
    <Text>
      {tokens.map((t, i) => (
        <InlineToken key={i} tok={t} />
      ))}
    </Text>
  );
};

const InlineToken: React.FC<{ tok: InlineTok }> = ({ tok }) => {
  switch (tok.kind) {
    case 'text':
      return <Text>{tok.value}</Text>;
    case 'code':
      return <Text color="cyan" backgroundColor="black">{` ${tok.value} `}</Text>;
    case 'bold':
      return <Text bold>{tok.value}</Text>;
    case 'italic':
      return <Text italic>{tok.value}</Text>;
    case 'link':
      return (
        <Text>
          <Text underline color="blue">{tok.label}</Text>
          <Text dimColor>{` (${tok.url})`}</Text>
        </Text>
      );
  }
};

type InlineTok =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'link'; label: string; url: string };

/**
 * Match `inline code`, **bold**, *italic*, [label](url) in priority order
 * (longest-match-wins via single combined regex). Everything between
 * matches becomes a plain text token.
 */
function tokenizeInline(input: string): InlineTok[] {
  const re = /(`[^`\n]+`)|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  const out: InlineTok[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIdx) {
      out.push({ kind: 'text', value: input.slice(lastIdx, match.index) });
    }
    if (match[1]) {
      out.push({ kind: 'code', value: match[1].slice(1, -1) });
    } else if (match[2]) {
      out.push({ kind: 'bold', value: match[3]! });
    } else if (match[4]) {
      out.push({ kind: 'italic', value: match[5]! });
    } else if (match[6]) {
      out.push({ kind: 'link', label: match[7]!, url: match[8]! });
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < input.length) {
    out.push({ kind: 'text', value: input.slice(lastIdx) });
  }
  return out;
}
