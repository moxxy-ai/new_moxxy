import { useEffect, useMemo, useRef } from 'react';
import type { Block } from '@/lib/useChat';
import { BlockView } from './BlockView';
import { ToolGroupView } from './ToolGroupView';
import { ThinkingIndicator } from './ThinkingIndicator';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/**
 * Render blocks grouped — consecutive tool blocks collapse into a
 * single ToolGroupView so the transcript stays readable when the
 * agent fires off several tool calls in a row.
 */
type RenderItem =
  | { kind: 'single'; key: string; block: Block }
  | { kind: 'tools'; key: string; tools: ReadonlyArray<ToolBlock> };

function groupBlocks(blocks: ReadonlyArray<Block>): RenderItem[] {
  const out: RenderItem[] = [];
  let toolBuf: ToolBlock[] = [];
  const flush = (): void => {
    if (toolBuf.length === 0) return;
    out.push({
      kind: 'tools',
      key: `tools-${toolBuf[0]!.id}`,
      tools: toolBuf,
    });
    toolBuf = [];
  };
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b);
    } else {
      flush();
      out.push({ kind: 'single', key: b.id, block: b });
    }
  }
  flush();
  return out;
}

export function Transcript({
  blocks,
  sending,
}: {
  readonly blocks: ReadonlyArray<Block>;
  /** True while a turn is in flight (between runTurn and turn.complete).
   *  Drives the "thinking" indicator that fills the gap before the
   *  first assistant_chunk arrives. */
  readonly sending?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const streamLen = blocks
    .filter((b) => b.kind === 'assistant')
    .reduce((acc, b) => acc + (b.kind === 'assistant' ? b.text.length : 0), 0);

  const items = useMemo(() => groupBlocks(blocks), [blocks]);

  useEffect(() => {
    if (!follow.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks.length, streamLen]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const slack = el.scrollHeight - el.scrollTop - el.clientHeight;
    follow.current = slack < 32;
  };

  return (
    <div
      ref={ref}
      data-testid="transcript"
      onScroll={onScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '20px 24px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {items.map((item) =>
        item.kind === 'tools' ? (
          <ToolGroupView key={item.key} tools={item.tools} />
        ) : (
          <BlockView key={item.key} block={item.block} />
        ),
      )}
      {sending && shouldShowThinking(blocks) && <ThinkingIndicator />}
    </div>
  );
}

/** Show the indicator only when there's no live assistant text yet.
 *  Once the first chunk lands the streaming cursor in BlockView takes
 *  over the "she's working" role. */
function shouldShowThinking(blocks: ReadonlyArray<Block>): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'assistant') {
      // Latest assistant block already has text → in-flight rendering
      // is being handled by the streaming-cursor inside BlockView.
      return b.streaming && b.text.length === 0;
    }
    if (b.kind === 'user') return true;
    // Tool / system blocks sit between user and the assistant reply
    // (skill load, etc.) — keep showing "thinking…" until the actual
    // assistant response starts.
    if (b.kind === 'tool' || b.kind === 'system') continue;
  }
  return true;
}
