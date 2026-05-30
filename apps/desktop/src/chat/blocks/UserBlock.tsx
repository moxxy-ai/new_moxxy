import { Icon } from '@/lib/Icon';

export function UserBlock({
  text,
  attachments,
}: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<string>;
}): JSX.Element {
  const hasAttachments = (attachments?.length ?? 0) > 0;
  return (
    <div
      data-testid="block-user"
      style={{
        alignSelf: 'flex-end',
        maxWidth: '78%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      {hasAttachments && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
          {attachments!.map((name, i) => (
            <span
              key={`${name}-${i}`}
              title={name}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: '#fff',
                border: '1px solid var(--color-primary)',
                borderRadius: 999,
                fontSize: 12,
                color: 'var(--color-primary-strong)',
                fontWeight: 600,
                maxWidth: 280,
              }}
            >
              <Icon name="attach" size={12} />
              <span
                className="mono"
                style={{
                  maxWidth: 220,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                @{name}
              </span>
            </span>
          ))}
        </div>
      )}
      {(text.length > 0 || !hasAttachments) && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--grad-user)',
            color: '#fff',
            borderRadius: '16px 16px 4px 16px',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.55,
            fontSize: 14.5,
            boxShadow: '0 6px 18px -10px rgba(236, 72, 153, 0.55)',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
