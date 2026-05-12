import React from 'react';
import { Box, Text } from 'ink';

export interface SessionInfoProps {
  readonly provider: string;
  readonly model: string;
  readonly loop: string;
  readonly toolCount: number;
  readonly toolPreview: ReadonlyArray<string>;
  readonly skillCount: number;
  readonly skillPreview: ReadonlyArray<string>;
  readonly pluginCount: number;
}

/**
 * Header table shown below the logo. Wrapped in a subtle rounded border
 * so it reads as one self-contained metadata block, separate from the
 * chat scrollback below. Two columns: dim label / value, with consistent
 * accent colors (cyan for "structural" choices like loop strategy,
 * magenta chip for provider).
 */
export const SessionInfo: React.FC<SessionInfoProps> = ({
  provider,
  model,
  loop,
  toolCount,
  toolPreview,
  skillCount,
  skillPreview,
  pluginCount,
}) => {
  const labelWidth = 10;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Row label="provider" labelWidth={labelWidth}>
        <Text backgroundColor="magenta" color="white" bold>{` ${provider} `}</Text>
        <Text>  </Text>
        <Text color="cyan">{model}</Text>
      </Row>
      <Row label="loop" labelWidth={labelWidth}>
        <Text color="cyan">{loop}</Text>
      </Row>
      <Row label="tools" labelWidth={labelWidth}>
        <Text bold color="green">{String(toolCount)}</Text>
        {toolPreview.length > 0 ? (
          <>
            <Text dimColor>  ·  </Text>
            <Text dimColor>{formatPreview(toolPreview, toolCount)}</Text>
          </>
        ) : null}
      </Row>
      <Row label="skills" labelWidth={labelWidth}>
        <Text bold color="yellow">{String(skillCount)}</Text>
        {skillPreview.length > 0 ? (
          <>
            <Text dimColor>  ·  </Text>
            <Text dimColor>{formatPreview(skillPreview, skillCount)}</Text>
          </>
        ) : null}
      </Row>
      <Row label="plugins" labelWidth={labelWidth}>
        <Text bold color="blue">{String(pluginCount)}</Text>
      </Row>
    </Box>
  );
};

const Row: React.FC<{ label: string; labelWidth: number; children?: React.ReactNode }> = ({
  label,
  labelWidth,
  children,
}) => (
  <Box>
    <Box width={labelWidth}>
      <Text dimColor>{label}</Text>
    </Box>
    {children}
  </Box>
);

function formatPreview(items: ReadonlyArray<string>, total: number): string {
  if (items.length === 0) return '';
  const shown = items.join(', ');
  if (total > items.length) return `${shown}, +${total - items.length} more`;
  return shown;
}
