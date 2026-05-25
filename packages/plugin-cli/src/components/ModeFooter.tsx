import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../theme.js';

/**
 * The active-mode segment of the status line. Shows the current mode
 * (formerly "loop strategy") and the hotkey to switch it, mirroring
 * Claude Code's "accept edits on (shift+tab to cycle)" footer.
 *
 *   ▸▸ mode: tool-use (shift+tab to cycle)
 *
 * Rendered on the left of `<StatusLine>` while idle; during a turn the
 * "Thinking" marker takes that slot instead.
 */
export const ModeFooter: React.FC<{ modeName: string }> = ({ modeName }) => (
  <Box>
    <Text color={Colors.mode}>{'▸▸ '}</Text>
    <Text color={Colors.mode} bold>
      mode: {modeName}
    </Text>
    <Text dimColor>{' (shift+tab to cycle)'}</Text>
  </Box>
);
