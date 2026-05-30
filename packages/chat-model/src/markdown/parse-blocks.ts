import type { Align, Block } from './types.js';

export function parseBlocks(src: string): Block[] {
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

function stripOuterPipes(s: string): string {
  return s.trim().replace(/^\|/, '').replace(/\|$/, '');
}

function parseTableCells(line: string): string[] {
  return stripOuterPipes(line)
    .split('|')
    .map((s) => s.trim());
}

function parseTableAligns(sep: string): Align[] {
  const cells = stripOuterPipes(sep).split('|');
  return cells.map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}
