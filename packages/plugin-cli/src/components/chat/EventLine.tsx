import React from 'react';
import { Box, Text } from 'ink';
import type { MoxxyEvent } from '@moxxy/sdk';
import { Colors, Glyphs } from '../../theme.js';
import { AssistantBlock } from './AssistantBlock.js';

export const EventLine: React.FC<{ event: MoxxyEvent }> = ({ event }) => {
  switch (event.type) {
    case 'user_prompt':
      // System-injected context notes (e.g. the /vault reference) aren't user
      // input — render them as a compact dim note rather than the bold pinned
      // bar, so they don't dominate the transcript.
      if (event.source && event.source !== 'user') {
        return (
          <Box marginTop={1}>
            <Text dimColor>{`${Glyphs.midDot} ${event.text}`}</Text>
          </Box>
        );
      }
      // Highlighted echo bar: bold prompt glyph + the user text, then a
      // dim horizontal rule under it. Matches the Grok-style "pinned
      // user prompt" treatment without needing a full bordered box.
      //
      // Layout note: glyph and body live in separate flex columns (same
      // pattern as AssistantBlock). A naked `<Box><Text>› </Text><Text bold>…
      // </Text></Box>` lets Ink's default `flexShrink: 1` on `<Text>`
      // squash the prompt glyph's trailing space at narrow widths and
      // mis-indent wrapped continuation lines.
      //
      // Display normalization: collapse runs of blank lines in the body
      // to a single line break. Pasted prose often carries paragraph
      // breaks (`\n\n+`); rendering them verbatim leaves an empty row
      // mid-bar that looks like a layout bug. The actual `event.text`
      // and what the model receives are untouched — this only tightens
      // the echo render.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={1} flexShrink={0}>
              <Text>{Glyphs.prompt}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Text bold>{collapseBlankLines(event.text)}</Text>
            </Box>
          </Box>
          <Text dimColor>{'─'.repeat(Math.min(60, event.text.length + 2))}</Text>
        </Box>
      );
    case 'assistant_message':
      return <AssistantBlock content={event.content} />;
    case 'skill_invoked':
      // SkillScopeView owns this render; if we reach here it means the
      // event escaped grouping (defensive fallback only).
      return null;
    case 'skill_created':
      return (
        <Box marginTop={1}>
          <Text dimColor>{Glyphs.filled} </Text>
          <Text bold>skill created</Text>
          <Text dimColor>  {event.name}</Text>
        </Box>
      );
    case 'plugin_registered':
      return (
        <Box>
          <Text dimColor>  + plugin: {event.name}@{event.version}</Text>
        </Box>
      );
    case 'compaction':
      return (
        <Box marginTop={1}>
          <Text dimColor>⤺ </Text>
          <Text dimColor>{formatCompactionEvent(event)}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={Colors.danger}>{Glyphs.filled} </Text>
          <Text color={Colors.danger}>error: </Text>
          <Text>{event.message}</Text>
        </Box>
      );
    case 'abort':
      return (
        <Box marginTop={1}>
          <Text color={Colors.busy}>⏹ aborted: {event.reason}</Text>
        </Box>
      );
    default:
      return null;
  }
};

/**
 * Display-only newline normalization for the user-prompt echo bar.
 * Drops blank lines (two or more newlines, optionally containing only
 * whitespace, collapse to a single `\n`) while preserving the user's
 * intentional single-line breaks. Leading/trailing whitespace is
 * trimmed so a stray paste-end blank doesn't push the rule down a row.
 */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n[ \t]*\n+/g, '\n').replace(/^\s+|\s+$/g, '');
}

export function formatCompactionEvent(event: Extract<MoxxyEvent, { type: 'compaction' }>): string {
  if (event.tokensSaved <= 0 || event.summary.trim().length === 0) {
    return 'context checked · nothing to compact';
  }
  const compactedEvents = event.replacedRange[1] - event.replacedRange[0] + 1;
  return `context compacted · ${formatCount(compactedEvents)} ${plural(compactedEvents, 'event')} · ~${formatTokenCount(event.tokensSaved)} tokens saved`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return formatCount(value);
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
