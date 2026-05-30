import React from 'react';
import { Box, Text } from 'ink';
import { parseBlocks, type Block } from '@moxxy/chat-model/markdown';
import { InlineText } from './markdown/inline.js';
import { TableBlock } from './markdown/table.js';

/**
 * Minimal terminal-friendly markdown renderer. Handles the subset the
 * assistant produces in chat replies — headings, bullet lists, numbered
 * lists, fenced code blocks, inline code, bold, italic, and links.
 * Anything else falls through as plain text.
 *
 * Zero dependencies (no `marked` / `markdown-it`); per-feature parsers
 * live in `./markdown/`. Good-enough is the right bar here — the chat is
 * ephemeral, the user will catch any rendering edge case visually.
 */
export interface MarkdownProps {
  readonly content: string;
  /**
   * When true, the first block's `marginTop` is suppressed. Used by
   * AssistantBlock so the response body sits flush with the bullet on
   * the same row, even when the body starts with a heading (which
   * would otherwise push the text down one line).
   */
  readonly firstBlockTight?: boolean;
}

export const Markdown: React.FC<MarkdownProps> = ({ content, firstBlockTight }) => {
  const blocks = parseBlocks(content);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} suppressTopMargin={firstBlockTight && i === 0} />
      ))}
    </Box>
  );
};

const BlockNode: React.FC<{ block: Block; suppressTopMargin?: boolean }> = ({
  block,
  suppressTopMargin,
}) => {
  switch (block.kind) {
    case 'heading': {
      const color = block.level === 1 ? 'cyan' : block.level === 2 ? 'magenta' : 'yellow';
      const mt = suppressTopMargin ? 0 : block.level <= 2 ? 1 : 0;
      return (
        <Box marginTop={mt}>
          <Text bold color={color}>{'#'.repeat(block.level)} </Text>
          <Text bold color={color}>{block.text}</Text>
        </Box>
      );
    }
    case 'paragraph':
      return (
        <Box>
          <InlineText text={block.text} />
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i}>
              <Text dimColor>{block.ordered ? `${i + 1}. ` : '• '}</Text>
              <InlineText text={item} />
            </Box>
          ))}
        </Box>
      );
    case 'code': {
      // Drop leading/trailing blank lines so the frame doesn't sprout
      // orphan rows above/below the code (models often emit
      // ```lang\n\n<code>\n``` with empty padding lines).
      const lines = block.body.split('\n');
      while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
      // `alignSelf="flex-start"` keeps the box at content width instead
      // of stretching to fill the parent column. That keeps the right
      // border tight against the code rather than running off into a
      // long empty rectangle where some terminals fail to draw it.
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          borderDimColor
          paddingX={1}
          alignSelf="flex-start"
        >
          {block.lang ? (
            <Text dimColor italic>{block.lang}</Text>
          ) : null}
          {lines.map((line, i) => (
            <Text key={i} color="cyan">{line}</Text>
          ))}
        </Box>
      );
    }
    case 'table':
      return <TableBlock block={block} suppressTopMargin={!!suppressTopMargin} />;
    case 'blank':
      return <Text> </Text>;
  }
};
