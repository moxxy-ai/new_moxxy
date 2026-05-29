import { useChat } from '@/lib/useChat';
import type { ConnectionPhase } from '@shared/ipc';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { Icon } from '@/lib/Icon';

interface ChatSurfaceProps {
  readonly phase: ConnectionPhase;
  readonly workspaceId: string;
  readonly railOpen: boolean;
  readonly onShowRail: () => void;
}

const SUGGESTIONS: ReadonlyArray<string> = [
  'Summarise the last turn',
  'Continue with the plan',
  'What can you do here?',
];

/**
 * Chat pane — the rightmost column. Card-style transcript with a
 * sticky header, suggested-action chips below the latest assistant
 * message, and a rounded composer floating against the pane's bottom.
 *
 * Streaming is visualised inside BlockView (a blinking block-cursor
 * trails the assistant text while chunks are still arriving). Auto-
 * scroll follows the bottom unless the user scrolls up to read.
 */
export function ChatSurface({
  phase,
  workspaceId,
  railOpen,
  onShowRail,
}: ChatSurfaceProps): JSX.Element {
  const chat = useChat(workspaceId);
  const ready = phase.phase === 'connected';

  return (
    <main className="col-main col-main--flat">
      <Header phase={phase} railOpen={railOpen} onShowRail={onShowRail} />
      {chat.blocks.length === 0 ? (
        <EmptyState ready={ready} />
      ) : (
        <Transcript blocks={chat.blocks} />
      )}
      {ready && !chat.sending && chat.blocks.length > 0 && (
        <SuggestedActions
          suggestions={SUGGESTIONS}
          onPick={(p) => void chat.send(p)}
        />
      )}
      <Composer
        ready={ready}
        sending={chat.sending}
        activeTurnId={chat.activeTurnId}
        onSend={(p) => void chat.send(p)}
        onAbort={() => void chat.abort()}
      />
      {chat.error && <ErrorToast text={chat.error} />}
    </main>
  );
}

function Header({
  phase,
  railOpen,
  onShowRail,
}: {
  readonly phase: ConnectionPhase;
  readonly railOpen: boolean;
  readonly onShowRail: () => void;
}): JSX.Element {
  const connected = phase.phase === 'connected';
  const sub =
    phase.phase === 'connected'
      ? `${phase.activeProvider ?? 'no provider'} · ${phase.activeMode ?? 'no mode'}`
      : phase.phase;
  return (
    <header
      style={{
        padding: '18px 24px 14px',
        borderBottom: '1px solid var(--color-card-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      {!railOpen && (
        <IconButton aria-label="Show context rail" onClick={onShowRail}>
          <Icon name="workspace" size={18} />
        </IconButton>
      )}
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
        Chat
      </h1>
      <span
        className="mono"
        style={{
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 999,
          color: connected ? 'var(--color-green)' : 'var(--color-text-dim)',
          background: connected ? '#dcfce7' : '#eef0f6',
          fontWeight: 600,
        }}
      >
        {sub}
      </span>
      <span style={{ flex: 1 }} />
      <IconButton aria-label="Search">
        <Icon name="search" size={18} />
      </IconButton>
      <IconButton aria-label="Notifications">
        <Icon name="bell" size={18} />
      </IconButton>
      <IconButton aria-label="New conversation">
        <Icon name="pencil" size={18} />
      </IconButton>
    </header>
  );
}

function IconButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      style={{
        width: 34,
        height: 34,
        borderRadius: 9,
        color: 'var(--color-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-card-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      {...rest}
    >
      {children}
    </button>
  );
}

function EmptyState({ ready }: { readonly ready: boolean }): JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            width: 56,
            height: 56,
            borderRadius: 16,
            background: 'var(--color-primary-soft)',
            color: 'var(--color-primary-strong)',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
          }}
        >
          <Icon name="agent" size={28} />
        </span>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {ready ? 'Ready when you are' : 'Connecting…'}
        </h2>
        <p style={{ margin: '6px 0 0', color: 'var(--color-text-dim)', fontSize: 13.5 }}>
          {ready
            ? 'Send a message to kick off this workspace.'
            : 'Waiting for the runner to come online…'}
        </p>
      </div>
    </div>
  );
}

function SuggestedActions({
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
            onClick={() => onPick(s)}
            style={{
              padding: '6px 12px',
              fontSize: 12.5,
              color: 'var(--color-text-muted)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 999,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-primary)')}
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = 'var(--color-card-border)')
            }
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ErrorToast({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        padding: '8px 14px',
        background: 'var(--color-red)',
        color: '#fff',
        borderRadius: 10,
        fontSize: 13,
        boxShadow: '0 14px 28px -16px rgba(239, 68, 68, 0.6)',
      }}
    >
      {text}
    </div>
  );
}
