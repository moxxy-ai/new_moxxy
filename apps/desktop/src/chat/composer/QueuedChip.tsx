import { Icon } from '@/lib/Icon';

/**
 * Pending-turn chip for messages the user queued while a previous
 * turn was still running. Renders with a soft "waiting" pulse so it
 * reads as pending, not "already sent."
 */
export function QueuedChip({
  text,
  onRemove,
}: {
  readonly text: string;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <span
      title={`Queued · sends when the current turn finishes\n${text}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 4px 4px 10px',
        background: 'var(--color-primary-soft)',
        border: '1px dashed var(--color-primary)',
        borderRadius: 999,
        fontSize: 12,
        color: 'var(--color-primary-strong)',
        fontWeight: 600,
        maxWidth: 280,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--color-primary-strong)',
          animation: 'moxxy-thinking 1.1s ease-in-out infinite',
        }}
      />
      <span
        style={{
          maxWidth: 220,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {text || '(attachment only)'}
      </span>
      <button
        type="button"
        aria-label="Drop queued message"
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
