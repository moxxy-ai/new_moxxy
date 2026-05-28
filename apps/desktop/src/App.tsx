import { useState } from 'react';
import { useSidecarStatus } from './lib/runner';
import { useRunnerSession, type Block } from './lib/runner-session';
import { useDesks } from './lib/desks';
import { DeskSidebar } from './desks/desk-sidebar';

export function App(): JSX.Element {
  const status = useSidecarStatus();
  const session = useRunnerSession();
  const desks = useDesks();
  const [theme] = useState<'dark' | 'light'>('dark');

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="app-sidebar">
        <SidebarHeader status={status} />
        <DeskSidebar api={desks} />
      </aside>
      <main className="app-main bp-grid-fade">
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
      </main>
    </div>
  );
}

interface SidebarHeaderProps {
  readonly status: 'starting' | 'running' | 'crashed' | 'stopped';
}

function SidebarHeader({ status }: SidebarHeaderProps): JSX.Element {
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
  readonly status: 'starting' | 'running' | 'crashed' | 'stopped';
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

function Transcript({
  blocks,
}: {
  readonly blocks: ReadonlyArray<Block>;
}): JSX.Element {
  return (
    <div
      data-testid="transcript"
      style={{
        position: 'absolute',
        inset: 0,
        bottom: 88,
        overflowY: 'auto',
        padding: '1.5rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}
    >
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} />
      ))}
    </div>
  );
}

function BlockView({ block }: { readonly block: Block }): JSX.Element {
  if (block.kind === 'user') {
    return (
      <div
        data-testid="block-user"
        style={{
          alignSelf: 'flex-end',
          maxWidth: '70%',
          padding: '0.5rem 0.75rem',
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-block)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {block.text}
      </div>
    );
  }
  if (block.kind === 'assistant') {
    return (
      <div
        data-testid="block-assistant"
        className="corner-bracket"
        style={{
          maxWidth: '85%',
          padding: '0.75rem 1rem',
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-block)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {block.text}
        {block.streaming && (
          <span
            aria-hidden
            style={{ marginLeft: 4, color: 'var(--color-primary)' }}
          >
            ▍
          </span>
        )}
      </div>
    );
  }
  // tool
  return (
    <div
      data-testid="block-tool"
      className="mono"
      style={{
        alignSelf: 'flex-start',
        fontSize: '0.75rem',
        padding: '0.25rem 0.5rem',
        color: 'var(--color-text-dim)',
        borderLeft: '2px solid var(--color-primary)',
      }}
    >
      [{block.status}] {block.name}
    </div>
  );
}

interface ComposerProps {
  readonly ready: boolean;
  readonly activeTurnId: string | null;
  readonly onSend: (prompt: string) => void;
  readonly onAbort: () => void;
}

function Composer({
  ready,
  activeTurnId,
  onSend,
  onAbort,
}: ComposerProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const disabled = !ready || activeTurnId !== null;

  return (
    <form
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.trim() || disabled) return;
        onSend(draft);
        setDraft('');
      }}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        padding: '1rem 2rem',
        background: 'var(--color-bg)',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'center',
      }}
    >
      <input
        data-testid="composer-input"
        aria-label="prompt"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          ready ? 'Ask anything…' : 'Waiting for runner…'
        }
        disabled={disabled}
        style={{
          flex: 1,
          padding: '0.5rem 0.75rem',
          fontSize: '0.95rem',
          color: 'var(--color-text)',
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-block)',
        }}
      />
      {activeTurnId === null ? (
        <button
          type="submit"
          data-testid="composer-send"
          disabled={disabled || !draft.trim()}
          style={{
            padding: '0.5rem 0.9rem',
            background: 'var(--color-primary)',
            color: 'var(--color-bg)',
            borderRadius: 'var(--radius-block)',
            fontWeight: 600,
            opacity: disabled || !draft.trim() ? 0.4 : 1,
          }}
        >
          Send
        </button>
      ) : (
        <button
          type="button"
          data-testid="composer-abort"
          onClick={() => onAbort()}
          style={{
            padding: '0.5rem 0.9rem',
            background: 'var(--color-pink)',
            color: 'var(--color-bg)',
            borderRadius: 'var(--radius-block)',
            fontWeight: 600,
          }}
        >
          Abort
        </button>
      )}
    </form>
  );
}

function ErrorBanner({ message }: { readonly message: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 96,
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
