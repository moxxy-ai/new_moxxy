import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { pickSlogan, selectLogo } from '../logo-data.js';
import { LogoLine } from './LogoLine.js';

/**
 * Banner shown at the top of the TUI: the moxxy mascot rendered dim-gray,
 * plus a rotating slogan. Steps down to the `MOXXY` wordmark and then a
 * one-line text mark on narrower terminals (see `selectLogo`).
 */
export const Logo: React.FC<{ subtitle?: string }> = ({ subtitle }) => {
  const width = process.stdout.columns ?? 80;
  // Memoize so a re-render of the parent doesn't shuffle the slogan on
  // every keystroke; we want one pick per session/mount.
  const slogan = useMemo(() => pickSlogan(), []);
  const { lines } = selectLogo(width);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <LogoLine key={i} text={line} />
      ))}
      <Box marginTop={1}>
        <Text dimColor italic>{slogan}</Text>
      </Box>
      {subtitle ? (
        <Box>
          <Text dimColor> {subtitle}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
