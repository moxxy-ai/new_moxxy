import React from 'react';
import { Box, Text } from 'ink';

/**
 * One row of the moxxy mark, rendered dim-gray. The art is a grayscale
 * picture, so there are no strokes-vs-fill classes to style — the whole
 * row fades uniformly, reading as quiet chrome on any theme. Used by both
 * `<Logo />` (post-boot TUI header) and `<BootScreen />`.
 */
export const LogoLine: React.FC<{ text: string }> = ({ text }) => (
  <Box>
    <Text color="gray" dimColor>
      {text}
    </Text>
  </Box>
);
