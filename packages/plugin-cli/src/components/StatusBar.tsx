import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  readonly provider: string;
  readonly model: string;
  /** Approximate input tokens consumed so far. */
  readonly contextUsed?: number;
  /** Active model's context window size. Required for the percentage. */
  readonly contextWindow?: number;
}

/**
 * Row below the prompt input. Left side: provider chip + model name.
 * Right side (when context info is available): "Nk / Nk (NN%)" sized
 * meter so the user can see how full the context window is before
 * the model starts dropping old turns.
 */
export const StatusBar: React.FC<StatusBarProps> = ({
  provider,
  model,
  contextUsed,
  contextWindow,
}) => (
  <Box marginTop={1} justifyContent="space-between">
    <Box>
      <Text backgroundColor="magenta" color="white" bold>{` ${provider} `}</Text>
      <Text dimColor>{`  ${model}`}</Text>
    </Box>
    {contextWindow ? (
      <ContextMeter used={contextUsed ?? 0} total={contextWindow} />
    ) : null}
  </Box>
);

const ContextMeter: React.FC<{ used: number; total: number }> = ({ used, total }) => {
  const pct = Math.min(100, Math.round((used / total) * 100));
  // Color the percentage by how close we are to the limit; the meter
  // becomes the "you're running out of room" warning surface.
  const color = pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : undefined;
  return (
    <Box>
      <Text dimColor>context </Text>
      <Text color={color}>{formatTokens(used)}</Text>
      <Text dimColor>{` / ${formatTokens(total)} `}</Text>
      <Text color={color}>{`(${pct}%)`}</Text>
    </Box>
  );
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
