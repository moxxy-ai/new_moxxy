import { useState } from 'react';
import { useSidecarStatus, type SidecarStatus } from './lib/runner';
import { useRunnerSession } from './lib/runner-session';
import { useDesks } from './lib/desks';
import { useWindows } from './lib/windows';
import { useRequirements } from './lib/requirements';
import { useRunnerInfo } from './lib/runner-info';
import { isMainWindow } from './lib/window-context';
import { DeskSidebar } from './desks/desk-sidebar';
import { Composer, Transcript } from './chat';
import { SchedulePanel } from './schedules';
import { SettingsPanel } from './settings';
import { RequirementsScreen } from './requirements';
import { InitWizard } from './onboarding';

type View = 'chat' | 'schedules' | 'settings';

export function App(): JSX.Element {
  const status = useSidecarStatus();
  const session = useRunnerSession();
  const desks = useDesks();
  const windows = useWindows();
  const requirements = useRequirements();
  const runner = useRunnerInfo();
  const [theme] = useState<'dark' | 'light'>('dark');
  const [view, setView] = useState<View>('chat');
  const showWindowControls = isMainWindow();

  // Layer 1 — system requirements (Node + moxxy CLI). If they're not
  // installed there's nothing for the runner to even attach to, so
  // the wizard takes the screen.
  const blockOnRequirements =
    isMainWindow() &&
    requirements.status !== null &&
    !requirements.status.allMet;

  if (blockOnRequirements) {
    return (
      <div className="app-shell" data-theme={theme} style={{ gridTemplateColumns: '1fr' }}>
        <main className="app-main bp-grid-fade">
          <RequirementsScreen api={requirements} />
        </main>
      </div>
    );
  }

  // Layer 2 — provider configuration. The runner is the authority:
  // once it attaches we read its SessionInfo, and if no provider is
  // active we run the inline init wizard (the in-app equivalent of
  // `moxxy init`). Only gate on this once we know the runner is
  // attached AND we've at least probed its info, so we don't flash
  // the wizard during the boot moment.
  const probedInfo = runner.info !== null;
  const needsInit =
    isMainWindow() &&
    session.ready &&
    probedInfo &&
    !runner.info?.activeProvider;

  if (needsInit) {
    return (
      <div className="app-shell" data-theme={theme} style={{ gridTemplateColumns: '1fr' }}>
        <main className="app-main bp-grid-fade">
          <InitWizard info={runner.info} onComplete={() => void runner.refresh()} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="app-sidebar">
        <SidebarHeader status={status} />
        <DeskSidebar api={desks} />
        <ViewSwitcher view={view} onChange={setView} />
        {showWindowControls && (
          <button
            type="button"
            data-testid="open-new-window"
            onClick={() => void windows.openSession()}
            disabled={windows.opening || status !== 'running'}
            style={{
              margin: '0.5rem 1rem',
              padding: '0.4rem 0.6rem',
              fontSize: '0.8rem',
              color: 'var(--color-text-dim)',
              border: '1px dashed var(--color-border-light)',
              borderRadius: 'var(--radius-block)',
              background: 'transparent',
              textAlign: 'left',
              opacity:
                windows.opening || status !== 'running' ? 0.5 : 1,
            }}
          >
            ↗ New window
          </button>
        )}
      </aside>
      <main className="app-main bp-grid-fade">
        {view === 'chat' ? (
          <>
            {session.blocks.length === 0 ? (
              <EmptyState status={status} ready={session.ready} />
            ) : (
              <Transcript blocks={session.blocks} />
            )}
            <Composer
              ready={session.ready && status === 'running'}
              activeTurnId={session.activeTurnId}
              onSend={(p) => void session.send(p)}
              onAbort={() => void session.abort()}
            />
            {session.error && <ErrorBanner message={session.error} />}
          </>
        ) : view === 'schedules' ? (
          <SchedulePanel />
        ) : (
          <SettingsPanel />
        )}
      </main>
    </div>
  );
}

function ViewSwitcher({
  view,
  onChange,
}: {
  readonly view: View;
  readonly onChange: (next: View) => void;
}): JSX.Element {
  const item = (target: View, label: string): JSX.Element => (
    <button
      type="button"
      data-testid={`nav-${target}`}
      data-active={view === target}
      onClick={() => onChange(target)}
      style={{
        padding: '0.4rem 0.75rem',
        fontSize: '0.8rem',
        textAlign: 'left',
        color:
          view === target ? 'var(--color-text)' : 'var(--color-text-muted)',
        borderLeft:
          view === target
            ? '2px solid var(--color-primary)'
            : '2px solid transparent',
        background:
          view === target ? 'var(--color-bg-card-hover)' : 'transparent',
      }}
    >
      {label}
    </button>
  );
  return (
    <nav
      style={{
        padding: '0.5rem 0 0.25rem',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          padding: '0.25rem 1rem',
          fontSize: '0.65rem',
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        View
      </header>
      {item('chat', '◇ Chat')}
      {item('schedules', '⏱ Schedules')}
      {item('settings', '⚙ Settings')}
    </nav>
  );
}

function SidebarHeader({ status }: { readonly status: SidecarStatus }): JSX.Element {
  const dot =
    status === 'running'
      ? 'var(--color-green)'
      : status === 'crashed'
        ? 'var(--color-pink)'
        : 'var(--color-text-dim)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '1rem',
        borderBottom: '1px solid var(--color-border)',
        fontSize: '0.875rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dot,
          boxShadow: status === 'running' ? `0 0 8px ${dot}` : 'none',
        }}
      />
      <span>runner</span>
      <span
        className="mono"
        style={{
          marginLeft: 'auto',
          fontSize: '0.7rem',
          color: 'var(--color-text-dim)',
        }}
        data-testid="runner-status"
      >
        {status}
      </span>
    </div>
  );
}

function EmptyState({
  status,
  ready,
}: {
  readonly status: SidecarStatus;
  readonly ready: boolean;
}): JSX.Element {
  return (
    <div className="empty-state">
      <div>
        <h1>
          <span className="grad-text">moxxy</span>
        </h1>
        <p>
          {ready
            ? 'Type a prompt below to start your first turn.'
            : status === 'running'
              ? 'Connect a provider to start your first turn.'
              : status === 'starting'
                ? 'Starting the local runner…'
                : 'Runner offline — open the dev panel to inspect logs.'}
        </p>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { readonly message: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 112,
        transform: 'translateX(-50%)',
        padding: '0.5rem 0.9rem',
        background: 'var(--color-pink)',
        color: 'var(--color-bg)',
        borderRadius: 'var(--radius-block)',
        fontSize: '0.85rem',
        boxShadow: 'var(--elev)',
      }}
    >
      {message}
    </div>
  );
}
