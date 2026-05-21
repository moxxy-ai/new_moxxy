import React from 'react';
import { Box, Text } from 'ink';
import type { MoxxyEvent } from '@moxxy/sdk';
import { Colors, Glyphs } from '../../theme.js';
import { AssistantBlock } from './AssistantBlock.js';

export const EventLine: React.FC<{ event: MoxxyEvent }> = ({ event }) => {
  switch (event.type) {
    case 'user_prompt':
      // Highlighted echo bar: bold prompt glyph + the user text, then a
      // dim horizontal rule under it. Matches the Grok-style "pinned
      // user prompt" treatment without needing a full bordered box.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text>{`${Glyphs.prompt} `}</Text>
            <Text bold>{event.text}</Text>
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
