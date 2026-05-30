import { useState } from 'react';
import { useDesks } from '@/lib/useDesks';
import { Skeleton } from '@/lib/Skeleton';
import { Icon } from '@/lib/Icon';
import { ConfirmModal } from '@/lib/Modal';
import { useUnreadWorkspaces } from '@/lib/useChat';
import type { Desk } from '@moxxy/desktop-ipc-contract';
import { Logo } from './workspace-sidebar/Logo';
import { SectionHeader } from './workspace-sidebar/SectionHeader';
import { WorkspaceRow } from './workspace-sidebar/WorkspaceRow';
import { NameWorkspaceModal } from './workspace-sidebar/NameWorkspaceModal';
import { ProfilePill } from './workspace-sidebar/ProfilePill';
import { listReset } from './workspace-sidebar/sidebar-styles';

export type View = 'chat' | 'workflows' | 'settings';

interface Props {
  readonly view: View;
  readonly onView: (v: View) => void;
}

// ---- menu config ----

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
      </div>
      {/* Menu is anchored to the bottom — Chat / Workflows / Settings sit
       *  just above the profile's top border, not buried at the top of the
       *  scrolling workspace list. */}
      <nav style={{ padding: '6px 12px 10px' }}>
        <SectionHeader title="Menu" />
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
      </nav>
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
