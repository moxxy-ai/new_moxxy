/**
 * Plain-string moxxy banner for non-Ink contexts (`moxxy --help`/`--version`,
 * the init wizard intro, doctor output). Reuses `selectLogo` from
 * `@moxxy/plugin-cli` so this helper and the TUI's React `<Logo />` step
 * through the same mascot → wordmark → text fallbacks at the same widths.
 * The slogan + version line is rendered by the caller (typically in the
 * clack-style box header right under the banner), not by this function —
 * that keeps the slogan from appearing twice.
 */

import { selectLogo } from '@moxxy/plugin-cli';
import { colors } from './colors.js';

export interface RenderLogoOptions {
  /** Horizontally center each line to `width` (default: left-aligned). */
  readonly center?: boolean;
}

/**
 * Dim-gray a logo row: `gray` (ANSI 90 / bright-black) + `dim` (SGR 2), both
 * relative to the terminal's own palette, so the banner reads as a quiet,
 * barely-there mark in any theme — matching the TUI's `<LogoLine>`.
 */
const fade = (s: string): string => colors.dim(colors.gray(s));

/**
 * Render the moxxy banner. `selectLogo` picks the mascot, the `MOXXY`
 * wordmark, or a one-line text mark based on `width`; every row is dim-gray
 * and (optionally) centered. Rows within a selection share one width, so
 * centering shifts the whole mark as a block rather than shearing it.
 */
export function renderLogo(
  width: number = process.stdout.columns ?? 80,
  opts: RenderLogoOptions = {},
): string {
  const { center = false } = opts;
  const { lines } = selectLogo(width);
  // ANSI codes are zero-width, so center off the raw line length, then style.
  const pad = (raw: string): string =>
    center ? ' '.repeat(Math.max(0, Math.floor((width - raw.length) / 2))) : '';
  const body = lines.map((line) => pad(line) + fade(line)).join('\n');
  return '\n' + body + '\n\n';
}
