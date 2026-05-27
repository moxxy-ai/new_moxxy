import { describe, expect, it } from 'vitest';
import { wrapLogicalLine } from './BufferLines.js';

describe('wrapLogicalLine', () => {
  it('returns a single empty row for an empty line', () => {
    expect(wrapLogicalLine('', 10)).toEqual([{ text: '', start: 0 }]);
  });

  it('breaks at word boundaries, keeping whole words together', () => {
    expect(wrapLogicalLine('hello world', 8)).toEqual([
      { text: 'hello ', start: 0 },
      { text: 'world', start: 6 },
    ]);
  });

  it('hard-breaks a single word longer than the width', () => {
    expect(wrapLogicalLine('abcdefghij', 4)).toEqual([
      { text: 'abcd', start: 0 },
      { text: 'efgh', start: 4 },
      { text: 'ij', start: 8 },
    ]);
  });

  it('never splits a short word across rows (the "mi" regression)', () => {
    // Width chosen so the wrap falls right around "mi": it must move whole to
    // the next row, not break into "m" / "i".
    const line = 'chcialbym abys mogl wygenerowac mi obrazki';
    const rows = wrapLogicalLine(line, 33); // "...wygenerowac " ends near col 32
    for (const r of rows) {
      expect(r.text).not.toMatch(/(^|\s)m$/); // no row ends with a lone "m"
      expect(r.text.trimStart()).not.toMatch(/^i(\s|$)/); // no row starts with lone "i"
    }
    // And the whole line is recoverable from the rows in order.
    expect(rows.map((r) => r.text).join('')).toBe(line);
  });

  it('reconstructs the original line from row slices', () => {
    const line = 'the quick brown fox jumps over the lazy dog';
    const rows = wrapLogicalLine(line, 12);
    expect(rows.map((r) => r.text).join('')).toBe(line);
    for (const r of rows) expect(r.text.length).toBeLessThanOrEqual(12);
  });
});
