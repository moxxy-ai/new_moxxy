import React from 'react';
import { Text } from 'ink';

const COLORS = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;

export interface RainbowTextProps {
  readonly children: string;
  readonly bold?: boolean;
}

/**
 * Per-character rainbow coloring. Each character gets a static color
 * from the palette in order. No animation — the rainbow is the
 * indicator, not its motion.
 */
export const RainbowText: React.FC<RainbowTextProps> = ({ children, bold }) => (
  <Text>
    {Array.from(children).map((ch, i) => (
      <Text key={i} bold={bold} color={COLORS[i % COLORS.length]}>
        {ch}
      </Text>
    ))}
  </Text>
);
