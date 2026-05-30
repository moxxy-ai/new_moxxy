/**
 * The Model chip — a single button entry point that opens the
 * provider/model modal. Shows the active "provider/model" label and a
 * disclosure caret; the actual disclosure is owned by the parent.
 */

export function ChipButton({
  label,
  value,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="btn-chip"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 10px',
        fontSize: 12.5,
        color: 'var(--color-text-muted)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 10,
        background: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ color: 'var(--color-text-dim)' }}>{label}:</span>
      <span
        style={{
          fontWeight: 600,
          color: 'var(--color-text)',
          maxWidth: 180,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </span>
      <span aria-hidden style={{ color: 'var(--color-text-dim)' }}>
        ▾
      </span>
    </button>
  );
}
