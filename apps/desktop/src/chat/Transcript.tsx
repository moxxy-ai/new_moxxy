import { useEffect, useMemo, useRef } from 'react';
import type { Block } from '@/lib/useChat';
import { BlockView } from './BlockView';
import { ToolGroupView } from './ToolGroupView';
import { SkillGroupView } from './SkillGroupView';
import { ThinkingIndicator } from './ThinkingIndicator';

interface TranscriptProps {
  readonly blocks: ReadonlyArray<Block>;
  readonly sending?: boolean;
  /** Forwarded into BlockView for the action_result dismiss control. */
  readonly workspaceId?: string;
}

type ToolBlock = Extract<Block, { kind: 'tool' }>;
type SkillMarker = Extract<Block, { kind: 'skill_marker' }>;

/**
 * Render-time grouping:
 *   - skill_marker + the preceding `load_skill` tool + every
 *     subsequent consecutive tool → one SkillGroupView block.
 *   - Plain consecutive tools (no skill context) → one ToolGroupView
 *     block.
 *   - Everything else renders as a single Block.
 *
 * "Subsequent tools belong to a skill" is heuristic: any tool block
 * that lands after the marker, before a non-tool block (assistant
 * text, user, system), is treated as part of the skill's activation.
 * That matches the way the agent invokes a skill (load → use its
 * tools → reply) without requiring a server-side group id.
 */
type RenderItem =
  | { kind: 'single'; key: string; block: Block }
  | { kind: 'tools'; key: string; tools: ReadonlyArray<ToolBlock> }
  | {
      kind: 'skill';
      key: string;
      name: string;
      reason: string;
      loadTool?: ToolBlock;
      tools: ReadonlyArray<ToolBlock>;
    };

function groupBlocks(blocks: ReadonlyArray<Block>): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (b.kind === 'tool') {
      // Collect run of consecutive tools.
      const tools: ToolBlock[] = [];
      while (i < blocks.length && blocks[i]!.kind === 'tool') {
        tools.push(blocks[i]! as ToolBlock);
        i++;
      }
      // Did a skill_marker immediately follow? Then those tools were
      // really the skill's "load tool + body" — wrap them as one
      // skill group. The loadTool is the LAST tool before the marker
      // (typically a load_skill call); everything in `tools` minus
      // that loader runs UNDER the skill.
      if (i < blocks.length && blocks[i]!.kind === 'skill_marker') {
        const marker = blocks[i]! as SkillMarker;
        i++;
        // Pull the load tool out of the trailing edge; the others are
        // probably part of the assistant's previous chain (rare).
        const loadTool = tools[tools.length - 1];
        const beforeLoad = tools.slice(0, -1);
        // Subsequent tools (until any non-tool block) belong to the
        // skill's body.
        const bodyTools: ToolBlock[] = [];
        while (i < blocks.length && blocks[i]!.kind === 'tool') {
          bodyTools.push(blocks[i]! as ToolBlock);
          i++;
        }
        if (beforeLoad.length > 0) {
          out.push({
            kind: 'tools',
            key: `tools-${beforeLoad[0]!.id}`,
            tools: beforeLoad,
          });
        }
        out.push({
          kind: 'skill',
          key: `skill-${marker.id}`,
          name: marker.name,
          reason: marker.reason,
          loadTool,
          tools: bodyTools,
        });
      } else if (tools.length > 0) {
        out.push({ kind: 'tools', key: `tools-${tools[0]!.id}`, tools });
      }
      continue;
    }
    if (b.kind === 'skill_marker') {
      // Marker without an immediately-preceding load_skill tool — open
      // a skill group, attach whatever consecutive tools follow.
      const bodyTools: ToolBlock[] = [];
      i++;
      while (i < blocks.length && blocks[i]!.kind === 'tool') {
        bodyTools.push(blocks[i]! as ToolBlock);
        i++;
      }
      out.push({
        kind: 'skill',
        key: `skill-${b.id}`,
        name: b.name,
        reason: b.reason,
        tools: bodyTools,
      });
      continue;
    }
    out.push({ kind: 'single', key: b.id, block: b });
    i++;
  }
  return out;
}

export function Transcript({ blocks, sending, workspaceId }: TranscriptProps): JSX.Element {
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
      {items.map((item) => {
        if (item.kind === 'tools') {
          return <ToolGroupView key={item.key} tools={item.tools} />;
        }
        if (item.kind === 'skill') {
          return (
            <SkillGroupView
              key={item.key}
              name={item.name}
              reason={item.reason}
              loadTool={item.loadTool}
              tools={item.tools}
            />
          );
        }
        return (
          <BlockView key={item.key} block={item.block} workspaceId={workspaceId} />
        );
      })}
      {sending && shouldShowThinking(blocks) && <ThinkingIndicator />}
    </div>
  );
}

function shouldShowThinking(blocks: ReadonlyArray<Block>): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'assistant') {
      return b.streaming && b.text.length === 0;
    }
    if (b.kind === 'user') return true;
    if (b.kind === 'tool' || b.kind === 'system' || b.kind === 'skill_marker') continue;
  }
  return true;
}
