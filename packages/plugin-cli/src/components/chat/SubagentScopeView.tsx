import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors, Glyphs } from '../../theme.js';
import { DotColors, formatElapsed, truncate, type SubagentBlock } from '@moxxy/chat-model';

export const SubagentScopeView: React.FC<{ scope: SubagentBlock }> = ({ scope }) => {
  const [now, setNow] = useState(() => Date.now());
  const running = scope.completedAtMs == null && scope.error == null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const endMs = scope.completedAtMs ?? now;
  const elapsed = formatElapsed(endMs - scope.startedAtMs);
  const toolPart = `${scope.toolCallCount} tool call${scope.toolCallCount === 1 ? '' : 's'}`;
  const dotColor = scope.error
    ? Colors.danger
    : running
      ? Colors.busy
      : DotColors.subagent;
  const state = scope.error ? 'failed' : running ? 'running' : 'done';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={dotColor}>{Glyphs.filled} </Text>
        <Text bold>{`agent `}</Text>
        <Text>{scope.label}</Text>
        <Text dimColor>{`  ${state} ${elapsed} · ${toolPart}`}</Text>
      </Box>
      {scope.error ? (
        <Box marginLeft={2}>
          <Text dimColor>└ </Text>
          <Text color={Colors.danger}>{truncate(scope.error, 100)}</Text>
        </Box>
      ) : scope.finalPreview && !running ? (
        <Box marginLeft={2}>
          <Text dimColor>{`└ ${truncate(scope.finalPreview, 100)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
