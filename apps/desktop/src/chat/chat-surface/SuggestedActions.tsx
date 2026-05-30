export function SuggestedActions({
  suggestions,
  onPick,
}: {
  readonly suggestions: ReadonlyArray<string>;
  readonly onPick: (prompt: string) => void;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '4px 24px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        Suggested actions
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="btn-suggestion"
            onClick={() => onPick(s)}
            style={{
              padding: '6px 12px',
              fontSize: 12.5,
              color: 'var(--color-text-muted)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 999,
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
