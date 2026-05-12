import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  readonly model: string;
  readonly provider: string;
  readonly toolCount: number;
  readonly skillCount: number;
  readonly cwd: string;
  readonly busy?: boolean;
}

/**
 * Single-line status row shown below the prompt input. Mirrors the kind of
 * info terminal-app statuslines usually carry (Vim-style): which model is
 * answering, which provider, how many tools/skills are wired, and the
 * project cwd. Kept compact so it fits on narrow terminals.
 */
export const StatusBar: React.FC<StatusBarProps> = ({
  model,
  provider,
  toolCount,
  skillCount,
  cwd,
  busy,
}) => {
  const shortCwd = shortenPath(cwd);
  return (
    <Box marginTop={1} flexDirection="row">
      <Text dimColor>{busy ? '⏺ ' : '○ '}</Text>
      <Text color="magenta">{provider}</Text>
      <Text dimColor>:</Text>
      <Text color="cyan">{model}</Text>
      <Text dimColor>  ·  </Text>
      <Text dimColor>{toolCount} tools, {skillCount} skills</Text>
      <Text dimColor>  ·  </Text>
      <Text dimColor>{shortCwd}</Text>
    </Box>
  );
};

function shortenPath(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}
