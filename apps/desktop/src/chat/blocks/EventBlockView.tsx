import type { MoxxyEvent } from '@moxxy/sdk';
import { UserBlock } from './UserBlock';
import { AssistantBlock } from './AssistantBlock';

export function EventBlockView({ event }: { readonly event: MoxxyEvent }): JSX.Element | null {
  switch (event.type) {
    case 'user_prompt':
      return (
        <UserBlock
          text={event.text}
          attachments={event.attachments?.map((a) => a.name ?? a.kind)}
        />
      );
    case 'assistant_message':
      return <AssistantBlock text={event.content} streaming={false} stopReason={event.stopReason} />;
    case 'error':
      return <SystemBlock text={event.message} tone="error" />;
    case 'abort':
      return <SystemBlock text={`aborted: ${event.reason}`} tone="info" />;
    default:
      // skill_invoked is consumed into skill-scope; everything else is
      // bookkeeping the chat surface doesn't render.
      return null;
  }
}

function SystemBlock({
  text,
  tone,
}: {
  readonly text: string;
  readonly tone: 'info' | 'error';
}): JSX.Element {
  const color = tone === 'error' ? 'var(--color-red)' : 'var(--color-text-dim)';
  return (
    <div
      data-testid="block-system"
      role={tone === 'error' ? 'alert' : 'status'}
      className="mono"
      style={{
        alignSelf: 'center',
        fontSize: 11,
        padding: '4px 10px',
        color,
        textTransform: 'lowercase',
        letterSpacing: '0.04em',
        opacity: 0.85,
      }}
    >
      — {text} —
    </div>
  );
}
