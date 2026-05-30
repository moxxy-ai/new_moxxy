import { Icon } from '@/lib/Icon';

/**
 * Pill rendered above the textarea for each attached file. Shows the
 * basename and a tiny × to drop it. The full absolute path lives on
 * the title= attr so a hover reveals where on disk the agent will
 * read it from.
 */
export function AttachmentChip({
  name,
  path,
  onRemove,
}: {
  readonly name: string;
  readonly path: string;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <span
      title={path}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 4px 4px 10px',
        background: 'var(--color-primary-soft)',
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
          maxWidth: 200,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        @{name}
      </span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'rgba(236, 72, 153, 0.18)',
          color: 'var(--color-primary-strong)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}
