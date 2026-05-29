import { useState } from 'react';
import { useDesks } from '@/lib/useDesks';
import { Skeleton } from '@/lib/Skeleton';
import { Icon } from '@/lib/Icon';
import { Modal, ConfirmModal } from '@/lib/Modal';
import { useUnreadWorkspaces } from '@/lib/useChat';
import type { Desk } from '@shared/ipc';

export type View = 'chat' | 'workflows' | 'settings';

interface Props {
  readonly view: View;
  readonly onView: (v: View) => void;
}

const MENU_ITEMS: ReadonlyArray<{
  id: View;
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
}> = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'workflows', label: 'Workflows', icon: 'workflow' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Dark left rail. Top: WORKSPACES (each desk = workspace). Middle:
 * MENU (Chat / Workflows / Settings). Bottom: user-profile pill that
 * doubles as a presence indicator.
 *
 * Density mirrors the reference shot — wide-enough rows (`44px`) to
 * read like nav, not a context menu.
 */
export function WorkspaceSidebar({ view, onView }: Props): JSX.Element {
  const desks = useDesks();
  const unread = new Set(useUnreadWorkspaces());
  const [busy, setBusy] = useState(false);
  /** Folder the user picked; null when no naming flow is in progress. */
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  /** Workspace queued for removal; null when no confirm is open. */
  const [pendingRemove, setPendingRemove] = useState<Desk | null>(null);

  const onStartNewWorkspace = async (): Promise<void> => {
    setBusy(true);
    try {
      const folder = await desks.pickFolder();
      if (folder) setPendingFolder(folder);
    } finally {
      setBusy(false);
    }
  };

  const onCreateWorkspace = async (name: string): Promise<void> => {
    if (!pendingFolder) return;
    const folder = pendingFolder;
    setPendingFolder(null);
    const desk = await desks.create(name.trim(), folder);
    if (desk) await desks.setActive(desk.id);
  };

  return (
    <aside className="col-sidebar">
      <Logo />
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 12px' }}>
        <SectionHeader title="Workspaces" />
        {desks.loading && desks.desks.length === 0 && (
          <div style={{ padding: '8px 0' }}>
            <Skeleton.Row />
            <Skeleton.Row />
          </div>
        )}
        <ul role="list" style={listReset}>
          {desks.desks.map((d) => (
            <WorkspaceRow
              key={d.id}
              desk={d}
              active={desks.activeId === d.id}
              unread={unread.has(d.id)}
              onClick={() => void desks.setActive(d.id)}
              onRemove={() => setPendingRemove(d)}
            />
          ))}
        </ul>
        <button
          type="button"
          data-testid="desk-new"
          onClick={() => void onStartNewWorkspace()}
          disabled={busy}
          style={{
            width: '100%',
            textAlign: 'left',
            padding: '10px 12px',
            marginTop: 6,
            fontSize: 13,
            color: 'var(--color-sidebar-text-dim)',
            borderRadius: 10,
            opacity: busy ? 0.6 : 1,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            style={{
              width: 20,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="plus" size={16} />
          </span>
          {busy ? 'Picking folder…' : 'New workspace'}
        </button>

        <SectionHeader title="Menu" style={{ marginTop: 20 }} />
        <ul role="list" style={listReset}>
          {MENU_ITEMS.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                data-testid={`nav-${m.id}`}
                data-active={view === m.id}
                onClick={() => onView(m.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '10px 12px',
                  fontSize: 13.5,
                  color:
                    view === m.id
                      ? 'var(--color-sidebar-text)'
                      : 'var(--color-sidebar-text-dim)',
                  background:
                    view === m.id ? 'var(--color-sidebar-bg-active)' : 'transparent',
                  borderRadius: 10,
                  fontWeight: view === m.id ? 600 : 500,
                }}
              >
                <span
                  style={{
                    width: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.85,
                  }}
                >
                  <Icon name={m.icon} size={17} />
                </span>
                <span>{m.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <ProfilePill />
      {pendingFolder && (
        <NameWorkspaceModal
          defaultName={pendingFolder.split('/').filter(Boolean).pop() ?? 'New workspace'}
          folder={pendingFolder}
          onCancel={() => setPendingFolder(null)}
          onSubmit={(name) => void onCreateWorkspace(name)}
        />
      )}
      {pendingRemove && (
        <ConfirmModal
          title="Remove workspace?"
          message={`The workspace "${pendingRemove.name}" will disappear from the sidebar. Files in ${pendingRemove.cwd} are not touched.`}
          confirmLabel="Remove"
          destructive
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            void desks.remove(pendingRemove.id);
            setPendingRemove(null);
          }}
        />
      )}
    </aside>
  );
}

function NameWorkspaceModal({
  defaultName,
  folder,
  onSubmit,
  onCancel,
}: {
  readonly defaultName: string;
  readonly folder: string;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState(defaultName);
  const canSubmit = name.trim().length > 0;
  return (
    <Modal title="New workspace" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(name);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
          }}
        >
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              padding: '9px 12px',
              fontSize: 14,
              color: 'var(--color-text)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
            }}
          />
        </label>
        <div
          className="mono"
          style={{
            fontSize: 11.5,
            color: 'var(--color-text-dim)',
            wordBreak: 'break-all',
            padding: '8px 10px',
            background: '#f7f8fc',
            border: '1px solid var(--color-card-border)',
            borderRadius: 8,
          }}
        >
          {folder}
        </div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              background: '#fff',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              color: '#fff',
              background: 'var(--color-primary-strong)',
              borderRadius: 10,
              fontWeight: 600,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            Create
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function Logo(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '18px 18px 14px',
      }}
    >
      <img
        src="/logo.png"
        alt="MoxxyAI Workspaces"
        width={32}
        height={32}
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          imageRendering: 'pixelated',
          flexShrink: 0,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-0.01em' }}>
          MoxxyAI
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--color-sidebar-text-dim)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          Workspaces
        </span>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  style,
}: {
  readonly title: string;
  readonly style?: React.CSSProperties;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '8px 12px 6px',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--color-sidebar-text-dim)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        ...style,
      }}
    >
      {title}
    </div>
  );
}

function WorkspaceRow({
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
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = 'var(--color-sidebar-bg-hover)';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent';
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

function ProfilePill(): JSX.Element {
  return (
    <div
      style={{
        margin: 12,
        padding: '10px 12px',
        background: 'var(--color-sidebar-bg-active)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #f59e0b, #f472b6)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 700,
          fontSize: 13,
        }}
      >
        ●
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-sidebar-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          You
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--color-sidebar-text-dim)' }}>
          Connected
        </div>
      </div>
    </div>
  );
}

const listReset: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
