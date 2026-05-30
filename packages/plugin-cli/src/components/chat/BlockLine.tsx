import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { Glyphs } from '../../theme.js';
import { EventLine } from './EventLine.js';
import { LiveToolBlock } from './LiveToolBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { SubagentScopeView } from './SubagentScopeView.js';
import {
  blocksEquivalent,
  countToolCalls,
  DotColors,
  truncate,
  type Block,
  type SkillScopeBlock,
} from '@moxxy/chat-model';

const NAME_DISPLAY_MAX = 48;

export interface BlockLineProps {
  readonly block: Block;
  /** Global Ctrl+O toggle. Expands every live-tools block at once. */
  readonly expandToolOutputs: boolean;
}

export const BlockLine: React.FC<BlockLineProps> = memo(
  function BlockLine({ block, expandToolOutputs }) {
    if (block.kind === 'event') return <EventLine event={block.event} />;
    if (block.kind === 'tool-call') {
      return <ToolCallBlock request={block.request} outcome={block.outcome} />;
    }
    if (block.kind === 'subagent') {
      return <SubagentScopeView scope={block} />;
    }
    if (block.kind === 'live-tools') {
      return <LiveToolBlock block={block} expanded={expandToolOutputs} />;
    }
    return <SkillScopeView scope={block} expandToolOutputs={expandToolOutputs} />;
  },
  // Blocks are mutated in-place by `pairToolEvents` (tool outcome
  // arrives, scope closes, subagent counter ticks). Compare the
  // render-relevant fields so an unrelated parent re-render (a
  // streaming-delta flush, an mcp poll) doesn't redraw every block.
  (prev, next) => {
    if (prev.expandToolOutputs !== next.expandToolOutputs) return false;
    return blocksEquivalent(prev.block, next.block);
  },
);

/**
 * Skill scopes always render expanded — child blocks (including any
 * live-tools aggregate inside) handle compaction themselves via the
 * global Ctrl+O toggle. The pre-existing "collapsed scope" treatment
 * was retired when live-tools blocks arrived; both achieved similar
 * visual compaction and having two toggles confused users.
 */
const SkillScopeView: React.FC<{
  scope: SkillScopeBlock;
  expandToolOutputs: boolean;
}> = ({ scope, expandToolOutputs }) => {
  const childToolCount = countToolCalls(scope.children);
  const nameLabel = truncate(scope.skillEvent.name, NAME_DISPLAY_MAX);
  const callLabel = `${childToolCount} tool call${childToolCount === 1 ? '' : 's'}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={DotColors.skill}>{Glyphs.filled} </Text>
        <Text bold>Skill</Text>
        <Text dimColor>{` (${nameLabel} · ${callLabel})`}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {scope.children.map((c) => (
          <BlockLine key={c.id} block={c} expandToolOutputs={expandToolOutputs} />
        ))}
      </Box>
    </Box>
  );
};
