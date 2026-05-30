import type { Block as FoldedBlock } from '@moxxy/chat-model';
import { SkillGroupView } from '../SkillGroupView';
import { EventBlockView } from './EventBlockView';
import { ToolBlock } from './ToolBlock';
import { SubagentView } from './SubagentView';

/**
 * One transcript block, rendered from the shared @moxxy/chat-model fold.
 *
 *   - event(user_prompt)      → right-aligned periwinkle bubble.
 *   - event(assistant_message)→ avatar + name + markdown + copy action.
 *   - event(error/abort)      → centered system note.
 *   - tool-call               → mono summary with status-coloured bar.
 *   - skill-scope             → SkillGroupView (banner + nested children).
 *   - subagent                → one-line agent row.
 *   - live-tools              → each call rendered as a tool row.
 *
 * The in-flight streaming assistant text is NOT a block — Transcript
 * renders it via {@link StreamingAssistant} at the tail.
 */
export function BlockView({ block }: { readonly block: FoldedBlock }): JSX.Element | null {
  switch (block.kind) {
    case 'event':
      return <EventBlockView event={block.event} />;
    case 'tool-call':
      return (
        <ToolBlock
          name={block.request.name}
          input={block.request.input}
          outcome={block.outcome}
        />
      );
    case 'skill-scope':
      return <SkillGroupView scope={block} />;
    case 'subagent':
      return <SubagentView block={block} />;
    case 'live-tools':
      return <LiveToolsBlock block={block} />;
  }
}

/** A live-tools aggregate renders each in-flight call as its own tool
 *  row — the fold keeps them grouped while the turn is still streaming. */
function LiveToolsBlock({
  block,
}: {
  readonly block: Extract<FoldedBlock, { kind: 'live-tools' }>;
}): JSX.Element {
  return (
    <>
      {block.calls.map((c) => (
        <ToolBlock
          key={c.id}
          name={c.request.name}
          input={c.request.input}
          outcome={c.outcome}
        />
      ))}
    </>
  );
}
