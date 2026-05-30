import { describe, expect, it } from 'vitest';
import { LOGO_LINES, LOGO_WIDTH, WORDMARK_LINES } from '@moxxy/plugin-cli';
import { colorsEnabled } from './colors.js';
import { renderLogo } from './logo.js';

// Strip ANSI so layout assertions don't have to encode color codes.
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// First non-blank rendered line, ANSI stripped — the top of the mark.
function firstLine(out: string): string {
  return strip(out).split('\n').filter((l) => l.trim())[0]!;
}

describe('renderLogo', () => {
  it('shows the full mascot on a wide terminal, left-aligned with no leading pad', () => {
    // The init wizard banner relies on the default being left-flush so the
    // clack `┌` corner connects under it.
    expect(firstLine(renderLogo(80))).toBe(LOGO_LINES[0]);
  });

  it('center adds symmetric leading padding sized to the terminal width', () => {
    const width = 100;
    const expectedPad = Math.floor((width - LOGO_WIDTH) / 2);
    expect(firstLine(renderLogo(width, { center: true }))).toBe(
      ' '.repeat(expectedPad) + LOGO_LINES[0],
    );
  });

  it('falls back to the MOXXY wordmark on a mid-width terminal', () => {
    expect(firstLine(renderLogo(50))).toBe(WORDMARK_LINES[0]);
  });

  it('falls back to a one-line text mark on ultra-narrow terminals', () => {
    expect(strip(renderLogo(20))).toContain('moxxy');
  });

  it('dims every glyph (gray + dim) when color is on, and strips back to the raw art', () => {
    const raw = renderLogo(80);
    // Stripping color must always round-trip back to the exact ASCII art.
    expect(firstLine(raw)).toBe(LOGO_LINES[0]);
    if (colorsEnabled) {
      expect(raw).toContain('\x1b[2m'); // dim
      expect(raw).toContain('\x1b[90m'); // gray
    }
  });
});
