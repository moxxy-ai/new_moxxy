import { useState } from 'react';
import { deskSwatches } from '@moxxy/ui-tokens';
import {
  nextSwatch,
  slugifyDeskId,
  type Desk,
  type DesksApi,
} from '@/lib/desks';

interface DeskSidebarProps {
  readonly api: DesksApi;
}

/**
 * The sidebar's desk list. Renders a single row per desk with its
 * accent dot, name, bound directory, and a "make active" affordance.
 * "New desk" pops the OS folder picker; on a selection it asks for a
 * name and persists.
 */
export function DeskSidebar({ api }: DeskSidebarProps): JSX.Element {
  const [creating, setCreating] = useState(false);

  const onNewDesk = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const dir = await api.pickFolder();
      if (!dir) return;
      const suggestedName = dir.split(/[/\\]/).filter(Boolean).pop() ?? 'New desk';
      const name = window.prompt('Name this desk', suggestedName) ?? '';
      if (!name.trim()) return;
      const id = slugifyDeskId(name);
      if (!id) return;
      const desk: Desk = {
        id,
        name: name.trim(),
        dir,
        color: nextSwatch(api.desks, deskSwatches),
      };
      await api.create(desk);
      await api.setActive(id);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-testid="desk-sidebar">
      <header
        style={{
          padding: '0.5rem 1rem 0.25rem',
          fontSize: '0.7rem',
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        Desks
      </header>
      <ul
        role="list"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {api.desks.map((d) => (
          <DeskRow
            key={d.id}
            desk={d}
            active={api.active === d.id}
            onActivate={() => void api.setActive(d.id)}
            onRemove={() => void api.remove(d.id)}
          />
        ))}
      </ul>
      <button
        type="button"
        data-testid="desk-sidebar-new"
        onClick={() => void onNewDesk()}
        disabled={creating}
        style={{
          margin: '0.5rem 1rem',
          padding: '0.4rem 0.6rem',
          fontSize: '0.8rem',
          color: 'var(--color-text-dim)',
          border: '1px dashed var(--color-border-light)',
          borderRadius: 'var(--radius-block)',
          background: 'transparent',
          textAlign: 'left',
          opacity: creating ? 0.5 : 1,
        }}
      >
        + New desk
      </button>
      {api.error && (
        <p
          role="alert"
          style={{
            margin: '0.5rem 1rem',
            fontSize: '0.75rem',
            color: 'var(--color-pink)',
          }}
        >
          {api.error}
        </p>
      )}
    </div>
  );
}

interface DeskRowProps {
  readonly desk: Desk;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onRemove: () => void;
}

function DeskRow({
  desk,
  active,
  onActivate,
  onRemove,
}: DeskRowProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  return (
    <li
      data-testid={`desk-row-${desk.id}`}
      data-active={active}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.4rem 1rem',
        cursor: 'pointer',
        background: active
          ? 'var(--color-bg-card-hover)'
          : hovered
            ? 'var(--color-bg-card)'
            : 'transparent',
        borderLeft: active
          ? '2px solid var(--color-primary)'
          : '2px solid transparent',
      }}
      onClick={onActivate}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: desk.color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          fontSize: '0.875rem',
          color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {desk.name}
      </span>
      {hovered && (
        <button
          type="button"
          data-testid={`desk-row-remove-${desk.id}`}
          aria-label={`Remove desk ${desk.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Remove desk "${desk.name}"?`)) onRemove();
          }}
          style={{
            color: 'var(--color-text-dim)',
            fontSize: '0.7rem',
            padding: '0 0.25rem',
          }}
        >
          ×
        </button>
      )}
    </li>
  );
}
