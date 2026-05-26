import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { Glyphs } from '../../theme.js';

/**
 * In-flight streaming indicator: a SINGLE constant-height row showing the tail
 * of the line currently being typed, prefixed with the same `◆` marker the
 * settled assistant block uses.
 *
 * Two properties this design buys us, both load-bearing — DO NOT regress:
 *
 *  1. No height jump. The previous version reserved a 4-row block (padded with
 *     blanks), so the live region ballooned to ~5 rows while streaming and then
 *     collapsed to the assistant block's ~2 rows on settle — the visible
 *     "indicator → blank line jump → response snaps back up" the user reported.
 *     A single row (matching the assistant block's first line + shared
 *     `marginTop`) means the live region barely changes height across the
 *     stream→settle transition.
 *
 *  2. No scrollback stacking. The preview renders OUTSIDE `<Static>` and Ink
 *     commits live-region rows to scrollback whenever the region GROWS by a
 *     line. A constant single row never grows, so Ink updates it in place
 *     instead of appending duplicate frames (the old long-stream bug).
 *
 * It deliberately renders RAW text (not markdown): the buffer is incomplete
 * markdown by definition (chunks cut mid-`**`, mid-`[link]`, mid-fence), so the
 * full Markdown pipeline only kicks in once the `assistant_message` event lands
 * and the message becomes a settled `<Static>` block.
 */
export const StreamingPreview: React.FC<{ content: string }> = memo(function StreamingPreview({
  content,
}) {
  const cols = process.stdout.columns ?? 80;
  // Room for the marker column (glyph + 1-col margin) plus a little slack.
  const innerCols = Math.max(20, cols - 4);

  // Show the most recent non-empty line so the row reads as live typing.
  const lines = content.split('\n');
  let line = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim()) {
      line = lines[i]!;
      break;
    }
  }
  if (!line) line = lines[lines.length - 1] ?? '';

  // Keep the END visible (leading ellipsis) so a long line scrolls left as it
  // grows rather than spilling onto a second row.
  const shown =
    line.length > innerCols ? `…${line.slice(line.length - (innerCols - 1))}` : line;

  return (
    <Box flexDirection="row" marginTop={1}>
      <Box marginRight={1}>
        <Text dimColor>{Glyphs.filled}</Text>
      </Box>
      <Text>{shown || ' '}</Text>
    </Box>
  );
});

/**
 * Identity passthrough kept for call-site / test stability — truncation now
 * lives entirely in the renderer above.
 */
export function tailForViewport(content: string): string {
  return content;
}
