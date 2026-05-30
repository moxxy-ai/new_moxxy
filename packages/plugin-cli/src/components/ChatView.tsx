import React, { useMemo, useRef } from 'react';
import { Box, Static } from 'ink';
import type { MoxxyEvent } from '@moxxy/sdk';
import { BlockLine } from './chat/BlockLine.js';
import { pairToolEvents, type Block, type CompactToolMap } from '@moxxy/chat-model';
import { advanceStaticScrollback } from './chat/static-window.js';
import { StreamingPreview, tailForViewport } from './chat/StreamingPreview.js';

export interface ChatViewProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly streamingDelta?: string;
  /** Global Ctrl+O toggle — expand every live-tools block at once. */
  readonly expandToolOutputs?: boolean;
  /** Per-tool compact-presentation metadata from the active tool registry. */
  readonly compactTools?: CompactToolMap;
  /**
   * Suppress the dynamic area (live blocks + streaming preview) while a
   * modal overlay is on screen. The Static, already-flushed scrollback
   * stays intact — only the still-mutating tail vanishes so the modal
   * doesn't push the combined live height past the terminal rows
   * (which is what triggers Ink's fallback "append every frame" mode
   * and leaves "shadow text" once the modal dismisses).
   */
  readonly hideLive?: boolean;
}

/**
 * Renders the chat scrollback. Pairs `tool_call_requested` events with
 * their matching `tool_result` / `tool_call_denied` so each tool use
 * shows as a single block:
 *
 *   ● Tool(arg=value, arg=value)
 *     └ result summary OR error reason
 *
 * Matches the visual rhythm of Claude Code's tool-use rendering.
 */
export const ChatView: React.FC<ChatViewProps> = ({
  events,
  streamingDelta,
  expandToolOutputs,
  compactTools,
  hideLive,
}) => {
  // pairToolEvents walks the whole events array. Parent re-renders
  // happen for unrelated state too (mcp-status poll, every streaming
  // delta tick, etc.), so memoize on the events reference — when a
  // chunk arrives setEvents creates a new array; everything else
  // keeps the old reference and we skip the walk entirely.
  const blocks = useMemo(
    () => pairToolEvents(events, compactTools),
    [events, compactTools],
  );
  // Keep a small settled tail in the live layout. Static is excellent
  // for old scrollback, but freezing every fresh message immediately
  // lets Ink append it at the current terminal cursor position, which
  // creates large blank gaps in the active viewport.
  const settledRef = useRef<Block[]>([]);
  const clearGenerationRef = useRef(0);
  const nextScrollback = advanceStaticScrollback({
    blocks,
    staticBlocks: settledRef.current,
    generation: clearGenerationRef.current,
  });
  settledRef.current = nextScrollback.staticBlocks;
  clearGenerationRef.current = nextScrollback.generation;
  const liveBlocks = nextScrollback.liveBlocks;
  return (
    <>
      <Static key={clearGenerationRef.current} items={settledRef.current}>
        {(block) => (
          <BlockLine
            key={block.id}
            block={block}
            expandToolOutputs={!!expandToolOutputs}
          />
        )}
      </Static>
      {hideLive ? null : (
        <Box flexDirection="column">
          {liveBlocks.map((b) => (
            <BlockLine
              key={b.id}
              block={b}
              expandToolOutputs={!!expandToolOutputs}
            />
          ))}
          {streamingDelta && streamingDelta.trim() ? (
            <StreamingPreview content={tailForViewport(streamingDelta)} />
          ) : null}
        </Box>
      )}
    </>
  );
};
