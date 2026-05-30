/**
 * Shared header for every settings tab — title + count pill + description,
 * with optional right-aligned action buttons. One component so the Providers /
 * MCP / Vault / Skills tabs stay visually identical.
 *
 * Layout is a 2×2 grid on purpose: the title sits in (row 1, col 1), the
 * description in (row 2, col 1), and any actions span BOTH rows in col 2.
 * Because the actions live in their own column they never inflate the title
 * row's height — so a tab WITH buttons (Skills) has the exact same title→
 * description spacing as a tab without (MCP / Providers / Vault). A plain flex
 * row would let the taller buttons push the description down on Skills only.
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
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        columnGap: 12,
        rowGap: 4,
        alignItems: 'center',
      }}
    >
      <div
        style={{
          gridColumn: 1,
          gridRow: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          minWidth: 0,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </h2>
        {count !== undefined && (
          <span
            style={{
              flexShrink: 0,
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
      </div>
      {actions && (
        <div
          style={{
            gridColumn: 2,
            gridRow: description ? '1 / 3' : 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {actions}
        </div>
      )}
      {description && (
        <p
          title={description}
          style={{
            gridColumn: 1,
            gridRow: 2,
            margin: 0,
            minWidth: 0,
            fontSize: 12.5,
            color: 'var(--color-text-dim)',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {description}
        </p>
      )}
    </div>
  );
}
