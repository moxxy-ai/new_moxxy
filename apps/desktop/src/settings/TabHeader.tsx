/**
 * Shared header for every settings tab — title + count pill + description,
 * with optional right-aligned action buttons. One component so the Providers /
 * MCP / Vault / Skills tabs stay visually identical (same type sizes, spacing,
 * and count pill) instead of each hand-rolling its own heading.
 */
export function TabHeader({
  title,
  count,
  description,
  actions,
}: {
  readonly title: string;
  readonly count?: number;
  readonly description?: string;
  readonly actions?: React.ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h2>
        {count !== undefined && (
          <span
            style={{
              minWidth: 22,
              textAlign: 'center',
              padding: '1px 7px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--color-text-muted)',
              background: 'rgba(148, 163, 184, 0.16)',
            }}
          >
            {count}
          </span>
        )}
        {actions && (
          <>
            <span style={{ flex: 1 }} />
            {actions}
          </>
        )}
      </div>
      {description && (
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--color-text-dim)', lineHeight: 1.5 }}>
          {description}
        </p>
      )}
    </div>
  );
}
