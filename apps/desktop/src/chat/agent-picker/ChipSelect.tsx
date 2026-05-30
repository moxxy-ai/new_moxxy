/**
 * The Mode chip — a flat native-select chip. Modes have no sub-list to
 * disclose, so the styled chip overlays a transparent native `<select>`
 * for the actual picking + a11y / keyboard behaviour.
 */

export function ChipSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label
      className="btn-chip"
      title={label}
      style={{
        position: 'relative',
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
        transition: 'border-color 140ms ease, box-shadow 140ms ease',
      }}
    >
      <span style={{ color: 'var(--color-text-dim)' }}>{label}:</span>
      <span
        style={{
          fontWeight: 600,
          color: 'var(--color-text)',
          maxWidth: 120,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value || '—'}
      </span>
      <span aria-hidden style={{ color: 'var(--color-text-dim)' }}>
        ▾
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
