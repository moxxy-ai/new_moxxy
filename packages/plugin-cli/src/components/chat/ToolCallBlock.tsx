import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ToolCallRequestedEvent, ToolResultEvent } from '@moxxy/sdk';
import { Colors, Glyphs } from '../../theme.js';
import { dotColorForTool, oneLine, stringify, summarizeArgs, truncate } from '@moxxy/chat-model';


/**
 * Pulsing `●` for in-flight tool calls. Toggles between full color and
 * dim every ~500ms so the user can tell at a glance that work is still
 * happening — a static yellow dot was reading as "stuck" when a long
 * shell command was running. The trailing space lives outside the
 * dimmed Text so the dim ANSI attribute can't bleed onto the tool name
 * that follows (some terminals interpret the boundary loosely and the
 * whole row appeared to pulse).
 */
const PendingBullet: React.FC = () => {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Text color={Colors.busy} dimColor={!on}>{Glyphs.filled}</Text>
      <Text> </Text>
    </>
  );
};

/** Cap displayed identifier length so an oversized MCP/skill name
 *  doesn't blow the header off the right edge of the terminal. */
const NAME_DISPLAY_MAX = 48;

export const ToolCallBlock: React.FC<{
  request: ToolCallRequestedEvent;
  outcome: ToolResultEvent | { type: 'denied'; reason: string } | null;
}> = ({ request, outcome }) => {
  const status: 'pending' | 'ok' | 'err' =
    outcome === null
      ? 'pending'
      : outcome.type === 'denied'
        ? 'err'
        : outcome.ok
          ? 'ok'
          : 'err';
  const argSummary = summarizeArgs(request.input);
  const nameLabel = truncate(request.name, NAME_DISPLAY_MAX);
  const detail = argSummary ? `${nameLabel}, ${argSummary}` : nameLabel;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {status === 'pending' ? (
          <PendingBullet />
        ) : status === 'err' ? (
          <Text color={Colors.danger}>{Glyphs.filled} </Text>
        ) : (
          <Text color={dotColorForTool(request.name)}>{Glyphs.filled} </Text>
        )}
        <Text bold>Tool</Text>
        <Text dimColor>{` (${detail})`}</Text>
      </Box>
      {outcome ? (
        <Box>
          <Text dimColor>  └ </Text>
          <OutcomeText outcome={outcome} />
        </Box>
      ) : null}
    </Box>
  );
};

const OutcomeText: React.FC<{
  outcome: ToolResultEvent | { type: 'denied'; reason: string };
}> = ({ outcome }) => {
  if (outcome.type === 'denied') {
    return <Text color={Colors.danger}>denied: {outcome.reason}</Text>;
  }
  if (!outcome.ok) {
    return (
      <Text color={Colors.danger}>
        {outcome.error?.kind ?? 'error'}: {outcome.error?.message}
      </Text>
    );
  }
  const preview = oneLine(stringify(outcome.output));
  return <Text dimColor>{truncate(preview, 100)}</Text>;
};
