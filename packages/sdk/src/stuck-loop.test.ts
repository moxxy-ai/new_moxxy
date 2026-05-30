import { describe, expect, it } from 'vitest';
import { createStuckLoopDetector } from './mode-helpers.js';

describe('createStuckLoopDetector', () => {
  it('trips on exact-input repeats at repeatThreshold', () => {
    const d = createStuckLoopDetector(); // repeatThreshold 3
    const input = { x: 1 };
    expect(d.record('Read', input).stuck).toBe(false);
    expect(d.record('Read', input).stuck).toBe(false);
    const sig = d.record('Read', input);
    expect(sig).toMatchObject({ stuck: true, count: 3, kind: 'exact' });
  });

  it('trips on same-target near-dups even when volatile args vary', () => {
    const d = createStuckLoopDetector(); // nearThreshold 5
    const url = 'https://example.com/big';
    // Same url, different maxBytes each time — exact check never fires.
    for (let i = 0; i < 4; i++) {
      expect(d.record('web_fetch', { url, maxBytes: 1000 * (i + 1) }).stuck).toBe(false);
    }
    const sig = d.record('web_fetch', { url, maxBytes: 99_000 });
    expect(sig).toMatchObject({ stuck: true, kind: 'near' });
    expect(sig.count).toBeGreaterThanOrEqual(5);
  });

  it('does NOT trip on distinct targets (legit multi-source fetching)', () => {
    const d = createStuckLoopDetector();
    for (let i = 0; i < 7; i++) {
      const sig = d.record('web_fetch', { url: `https://example.com/page-${i}`, maxBytes: 8000 });
      expect(sig.stuck).toBe(false);
    }
  });

  it('ignores near-dups for tools with no identity arg', () => {
    const d = createStuckLoopDetector();
    // No url/path/command field — near tracking is skipped; only exact applies.
    for (let i = 0; i < 6; i++) {
      const sig = d.record('think', { note: `step ${i}` });
      expect(sig.stuck).toBe(false);
    }
  });
});
