/**
 * One workspace (desk) entry in the rail: coloured monogram tile, name,
 * an unread-activity dot, and a hover-only remove (×) affordance. The
 * row itself is the click target; the remove button stops propagation so
 * it doesn't double as a "select workspace".
 */
export function WorkspaceRow({
  desk,
  active,
  unread,
  onClick,
  onRemove,
}: {
  readonly desk: { id: string; name: string; color: string };
  readonly active: boolean;
  readonly unread: boolean;
  readonly onClick: () => void;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <li>
      <div
        data-testid={`desk-row-${desk.id}`}
        data-active={active}
        onClick={onClick}
        className={active ? undefined : 'row-button'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          borderRadius: 10,
          cursor: 'pointer',
          background: active ? 'var(--color-sidebar-bg-active)' : 'transparent',
          color: active ? 'var(--color-sidebar-text)' : 'var(--color-sidebar-text-dim)',
          fontWeight: active ? 600 : 500,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: `${desk.color}1f`,
            color: desk.color,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {desk.name.slice(0, 1).toUpperCase()}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 13.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {desk.name}
        </span>
        {unread && (
          <span
            aria-label="unread activity"
            title="New activity in this workspace"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--color-primary)',
              flexShrink: 0,
              boxShadow: '0 0 8px rgba(236, 72, 153, 0.6)',
            }}
          />
        )}
        <button
          type="button"
          aria-label={`remove workspace ${desk.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            color: 'var(--color-sidebar-text-dim)',
            opacity: active ? 1 : 0.55,
            padding: '0 4px',
            fontSize: 14,
          }}
        >
          ×
        </button>
      </div>
    </li>
  );
}
