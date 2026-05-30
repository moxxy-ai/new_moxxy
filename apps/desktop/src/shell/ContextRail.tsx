/**
 * Right-hand context rail. Lives next to the chat and surfaces
 * supplementary, side-of-stream content:
 *
 *   - Output preview — skill / tool outputs that benefit from a
 *     persistent viewer (charts, HTML, file previews).
 *   - Future zones: pinned references, agent scratchpad, deep-link
 *     to the workspace's files, etc.
 *
 * Sections are intentionally empty stubs today; they'll be wired as
 * the corresponding chat events ("present_view", "skill_output", etc.)
 * land.
 */

import { useState } from 'react';
import { useDesks } from '@/lib/useDesks';
import { Icon } from '@/lib/Icon';
import { WorkspaceFiles } from './WorkspaceFiles';

interface Props {
  readonly onClose: () => void;
  /** Controlled open state. The rail stays mounted in both states
   *  so the CSS width transition can play; content is hidden via
   *  the `data-open="false"` selector that also collapses the
   *  border. Keeps the workspace + file tree alive between toggles
   *  so re-open is instant. */
  readonly open: boolean;
  /** The workspace the rest of the UI is showing. The rail is
   *  workspace-scoped (info + file tree), so it must track the SAME id
   *  the chat does — deriving its own from `desks.activeId` let it lag
   *  behind a switch and show the wrong workspace's (empty) files. */
  readonly workspaceId: string | null;
}

export function ContextRail({ onClose, open, workspaceId }: Props): JSX.Element {
  const desks = useDesks();
  const active = desks.desks.find((d) => d.id === workspaceId);
  // Bumping this re-reads the file tree (the button next to the FILES heading).
  const [filesReload, setFilesReload] = useState(0);

  return (
    <section
      className="col-rail col-rail--right"
      data-open={open}
      aria-hidden={!open}>
      <Header onClose={onClose} />

      <Section title="Workspace">
        {active ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row
              icon={<ColorDot color={active.color} />}
              title={active.name}
              subtitle="Active workspace"
            />
            <Path text={active.cwd} />
          </div>
        ) : (
          <Row
            icon={<Icon name="workspace" size={14} />}
            title="No workspace bound"
            subtitle="Create one in the sidebar"
          />
        )}
      </Section>

      <Divider />

      <Section
        title="Files"
        action={
          active ? (
            <button
              type="button"
              className="btn-icon"
              aria-label="Reload files"
              title="Reload files"
              onClick={() => setFilesReload((k) => k + 1)}
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                color: 'var(--color-text-dim)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="rotate" size={13} />
            </button>
          ) : undefined
        }
      >
        {active ? (
          <WorkspaceFiles workspaceId={active.id} reloadSignal={filesReload} />
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-dim)' }}>
            Pick a workspace to browse its files.
          </div>
        )}
      </Section>
    </section>
  );
}

function Header({ onClose }: { readonly onClose: () => void }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 64,
        minHeight: 64,
        flexShrink: 0,
        boxSizing: 'border-box',
        padding: '0 16px',
        borderBottom: '1px solid var(--color-card-border)',
        position: 'sticky',
        top: 0,
        background: 'var(--color-card-bg)',
        zIndex: 1,
      }}
    >
      <button
        type="button"
        aria-label="Collapse context"
        onClick={onClose}
        style={iconBtnStyle}
      >
        <Icon name="chevron-right" size={14} />
      </button>
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        Context
      </span>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section style={{ padding: '14px 16px 16px' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 10,
        }}
      >
        <span>{title}</span>
        {action && (
          <>
            <span style={{ flex: 1 }} />
            {action}
          </>
        )}
      </header>
      {children}
    </section>
  );
}

function Row({
  icon,
  title,
  subtitle,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly subtitle?: string;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: 'var(--color-primary-soft)',
          color: 'var(--color-primary-strong)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-dim)' }}>{subtitle}</div>
        )}
      </div>
    </div>
  );
}

function Path({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      className="mono"
      title={text}
      style={{
        fontSize: 11.5,
        color: 'var(--color-text-muted)',
        background: '#f7f8fc',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--color-card-border)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </div>
  );
}

function ColorDot({ color }: { readonly color: string }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: color,
      }}
    />
  );
}

function Divider(): JSX.Element {
  return (
    <hr
      style={{
        border: 'none',
        borderTop: '1px solid var(--color-card-border)',
        margin: '0 16px',
      }}
    />
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  color: 'var(--color-text-dim)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--color-card-border)',
  background: '#fff',
};
