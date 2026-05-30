import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { MoxxyEvent } from '@moxxy/sdk';
import { blocksEquivalent, type Block as FoldedBlock } from '@moxxy/chat-model';
import { buildRenderNodes, groupToolNodes, type Extension, type RenderNode } from '@/lib/useChat';
import { BlockView, StreamingAssistant } from './BlockView';
import { ToolGroupView } from './ToolGroupView';
import { ExtensionCard } from './ExtensionCard';
import { ThinkingIndicator } from './ThinkingIndicator';

interface TranscriptProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly extensions: ReadonlyArray<Extension>;
  readonly streamingText: string;
  readonly sending?: boolean;
  /** Forwarded into ExtensionCard for the dismiss control. */
  readonly workspaceId?: string;
  /** True when older history can be paged in by scrolling to the top. */
  readonly hasOlder?: boolean;
  /** Fired when the user scrolls to the top edge — load the older page. */
  readonly onReachedTop?: () => void;
}

/** Memoised per-block so a streaming chunk (which only changes
 *  `streamingText`) doesn't repaint settled rows. */
const MemoBlock = memo(
  function MemoBlock({ block }: { readonly block: FoldedBlock }): JSX.Element | null {
    return <BlockView block={block} />;
  },
  (a, b) => blocksEquivalent(a.block, b.block),
);

/** Row gutter — Virtuoso measures each item, so spacing rides on the row
 *  rather than a flex `gap`. Flex column so each block's `alignSelf`
 *  (user → right, tool → left, assistant → stretch) is honoured; in the
 *  old flat flex container it worked for free, but each virtualised row is
 *  its own element now. */
const ROW: React.CSSProperties = { padding: '8px 24px', display: 'flex', flexDirection: 'column' };

function keyOf(node: RenderNode): string {
  if (node.kind === 'ext') return node.ext.id;
  if (node.kind === 'tool-group') return node.id;
  return node.block.id;
}

function Row({ node, workspaceId }: { readonly node: RenderNode; readonly workspaceId?: string }): JSX.Element {
  return (
    <div style={ROW}>
      {node.kind === 'ext' ? (
        <ExtensionCard ext={node.ext} workspaceId={workspaceId} />
      ) : node.kind === 'tool-group' ? (
        <ToolGroupView tools={node.tools} />
      ) : (
        <MemoBlock block={node.block} />
      )}
    </div>
  );
}

/** Virtuoso's `firstItemIndex` must decrease by exactly the number of
 *  rows prepended so the scroll position stays anchored. Start high so it
 *  never goes negative across a long session of scroll-ups. */
const BASE_FIRST_INDEX = 1_000_000;

/**
 * Virtualised transcript. Only the visible window mounts to the DOM, so a
 * workspace with thousands of messages stays smooth. `followOutput` pins
 * to the latest turn unless the user scrolls up; `startReached` +
 * `firstItemIndex` page in older history (Phase 7 cursor pagination)
 * without jumping the scroll position.
 */
export function Transcript({
  events,
  extensions,
  streamingText,
  sending,
  workspaceId,
  hasOlder,
  onReachedTop,
}: TranscriptProps): JSX.Element {
  // Fold only when committed events / extensions change — never on a
  // streaming tick (the events array reference is stable across chunks).
  const nodes = useMemo(
    () => groupToolNodes(buildRenderNodes(events, extensions)),
    [events, extensions],
  );

  // Track how many rows have been prepended so far and shift
  // firstItemIndex by that amount. Detect a prepend by finding where the
  // previous head row landed in the new list.
  const [firstItemIndex, setFirstItemIndex] = useState(BASE_FIRST_INDEX);
  const prevHeadKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const headKey = nodes.length > 0 ? keyOf(nodes[0]!) : null;
    if (prevHeadKey.current !== null && headKey !== prevHeadKey.current) {
      const idx = nodes.findIndex((n) => keyOf(n) === prevHeadKey.current);
      if (idx > 0) setFirstItemIndex((v) => v - idx);
    }
    prevHeadKey.current = headKey;
  }, [nodes]);

  return (
    <Virtuoso<RenderNode>
      data={nodes as RenderNode[]}
      data-testid="transcript"
      style={{ flex: 1 }}
      // Only follow when the user is already at the bottom (scrolling up to
      // read is never interrupted). A newly-committed line scrolls SMOOTHLY;
      // during active streaming we pin instantly so rapid chunks don't stack
      // overlapping smooth-scroll animations into jank.
      followOutput={(atBottom) => (atBottom ? (streamingText ? 'auto' : 'smooth') : false)}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={Math.max(0, nodes.length - 1)}
      {...(hasOlder && onReachedTop ? { startReached: onReachedTop } : {})}
      computeItemKey={(_i, node) => keyOf(node)}
      itemContent={(_i, node) => <Row node={node} workspaceId={workspaceId} />}
      components={{
        Footer: () => (
          <div style={{ padding: '0 24px 12px' }}>
            {streamingText && <StreamingAssistant text={streamingText} />}
            {sending && streamingText === '' && <ThinkingIndicator />}
          </div>
        ),
      }}
    />
  );
}
