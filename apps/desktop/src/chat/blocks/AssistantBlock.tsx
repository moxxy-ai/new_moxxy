import { Icon } from '@/lib/Icon';
import { MarkdownBody } from '../MarkdownBody';
import { ActionRow } from './ActionRow';

export function AssistantBlock({
  text,
  streaming,
  stopReason,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly stopReason?: string;
}): JSX.Element {
  return (
    <div
      data-testid="block-assistant"
      data-streaming={streaming}
      style={{ alignSelf: 'stretch', display: 'flex', gap: 12, maxWidth: '92%' }}
    >
      <Avatar />
      <div style={{ flex: 1, minWidth: 0 }}>
        <AssistantHeader streaming={streaming} />
        <div style={{ marginTop: 6 }}>
          <MarkdownBody text={text} streaming={streaming} />
        </div>
        {stopReason && stopReason !== 'end_turn' && (
          <div
            className="mono"
            style={{
              marginTop: 6,
              fontSize: 10.5,
              color: 'var(--color-text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            stop: {stopReason.replace(/_/g, ' ')}
          </div>
        )}
        {!streaming && <ActionRow text={text} />}
      </div>
    </div>
  );
}

function Avatar(): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        background: 'var(--color-primary-soft)',
        color: 'var(--color-primary-strong)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Icon name="agent" size={18} />
    </span>
  );
}

function AssistantHeader({ streaming }: { readonly streaming: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontWeight: 600, fontSize: 13.5 }}>Assistant</span>
      {streaming && (
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--color-primary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-primary)',
              animation: 'moxxy-pulse 1.2s ease-in-out infinite',
            }}
          />
          typing…
        </span>
      )}
    </div>
  );
}
