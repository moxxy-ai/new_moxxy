import { memo, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { MoxxyEvent } from '@moxxy/sdk';
import { blocksEquivalent, type Block as FoldedBlock } from '@moxxy/chat-model';
import { buildRenderNodes, type Extension, type RenderNode } from '@/lib/useChat';
import { BlockView, StreamingAssistant } from './BlockView';
import { ExtensionCard } from './ExtensionCard';
import { ThinkingIndicator } from './ThinkingIndicator';

interface TranscriptProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly extensions: ReadonlyArray<Extension>;
  readonly streamingText: string;
  readonly sending?: boolean;
  /** Forwarded into ExtensionCard for the dismiss control. */
  readonly workspaceId?: string;
  /**
   * Pagination (Phase 7): the virtual index of the first loaded item, so
   * Virtuoso anchors scroll position when older pages are prepended;
   * `onReachedTop` fires when the user scrolls to the top edge.
   */
  readonly firstItemIndex?: number;
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
 *  rather than a flex `gap`. */
const ROW: React.CSSProperties = { padding: '8px 24px' };

function Row({ node, workspaceId }: { readonly node: RenderNode; readonly workspaceId?: string }): JSX.Element {
  return (
    <div style={ROW}>
      {node.kind === 'ext' ? (
        <ExtensionCard ext={node.ext} workspaceId={workspaceId} />
      ) : (
        <MemoBlock block={node.block} />
      )}
    </div>
  );
}

/**
 * Virtualised transcript. Only the visible window mounts to the DOM, so
 * a workspace with thousands of messages stays smooth. `followOutput`
 * keeps the view pinned to the latest turn unless the user scrolls up;
 * `firstItemIndex` + `startReached` cooperate with cursor pagination
 * (Phase 7) so prepending older pages doesn't jump the scroll position.
 */
export function Transcript({
  events,
  extensions,
  streamingText,
  sending,
  workspaceId,
  firstItemIndex,
  onReachedTop,
}: TranscriptProps): JSX.Element {
  const nodes = useMemo(() => buildRenderNodes(events, extensions), [events, extensions]);

  return (
    <Virtuoso<RenderNode>
      data={nodes as RenderNode[]}
      data-testid="transcript"
      style={{ flex: 1 }}
      followOutput="auto"
      initialTopMostItemIndex={Math.max(0, nodes.length - 1)}
      {...(firstItemIndex !== undefined ? { firstItemIndex } : {})}
      {...(onReachedTop ? { startReached: onReachedTop } : {})}
      computeItemKey={(_i, node) => (node.kind === 'ext' ? node.ext.id : node.block.id)}
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
