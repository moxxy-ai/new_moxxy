import type { ConnectionSnapshot } from '@moxxy/desktop-ipc-contract';

interface ConnectionScreenProps {
  readonly snapshot: ConnectionSnapshot | null;
  readonly onRetry: () => void;
}

/**
 * Full-pane status screen for every phase except `connected`. Speaks
 * the user's language ("Looking for moxxy…", "Starting the runner…",
 * "Couldn't connect — here's why") and offers a retry on stuck states.
 */
export function ConnectionScreen({
  snapshot,
  onRetry,
}: ConnectionScreenProps): JSX.Element {
  const phase = snapshot?.phase ?? { phase: 'idle' };
  const showLog =
    snapshot &&
    snapshot.log.length > 0 &&
    (phase.phase === 'reconnecting' ||
      phase.phase === 'failed' ||
      phase.phase === 'cli-missing' ||
      phase.phase === 'spawning');

  return (
    <main className="app-main bp-grid">
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
        }}
      >
        <div
          className="elev"
          style={{
            maxWidth: 520,
            width: '100%',
            padding: '1.5rem 1.75rem',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-block)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          <header>
            <h1
              style={{
                margin: 0,
                fontSize: '1.5rem',
                fontWeight: 700,
                letterSpacing: '-0.025em',
              }}
            >
              <span className="grad-text">moxxy</span>
            </h1>
            <p
              style={{
                margin: '0.25rem 0 0',
                color: 'var(--color-text)',
                fontSize: '0.95rem',
              }}
            >
              {titleFor(phase.phase)}
            </p>
          </header>

          <DetailRow label="phase" value={phase.phase} />
          {snapshot?.cliPath && (
            <DetailRow label="moxxy" value={snapshot.cliPath} />
          )}
          {'socket' in phase && phase.socket && (
            <DetailRow label="socket" value={phase.socket} />
          )}
          {phase.phase === 'cli-missing' && (
            <DetailRow label="hint" value={phase.hint} />
          )}
          {phase.phase === 'spawning' && phase.pid && (
            <DetailRow label="pid" value={String(phase.pid)} />
          )}
          {phase.phase === 'reconnecting' && (
            <>
              <DetailRow label="reason" value={phase.reason} />
              <DetailRow label="attempt" value={String(phase.attempt)} />
            </>
          )}
          {phase.phase === 'failed' && (
            <>
              <DetailRow label="error" value={phase.error} />
              {phase.hint && <DetailRow label="hint" value={phase.hint} />}
            </>
          )}

          {showLog && snapshot && (
            <details>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: '0.7rem',
                  color: 'var(--color-text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                recent runner output ({snapshot.log.length})
              </summary>
              <pre
                className="mono"
                style={{
                  margin: '0.4rem 0 0',
                  padding: '0.5rem 0.6rem',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-block)',
                  fontSize: '0.7rem',
                  color: 'var(--color-text-muted)',
                  maxHeight: 240,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {snapshot.log.map((l) => `[${l.stream}] ${l.line}`).join('\n')}
              </pre>
            </details>
          )}

          {(phase.phase === 'failed' ||
            phase.phase === 'reconnecting' ||
            phase.phase === 'cli-missing') && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                alignSelf: 'flex-end',
                padding: '0.45rem 0.95rem',
                background: 'var(--color-primary)',
                color: 'var(--color-bg)',
                borderRadius: 'var(--radius-block)',
                fontWeight: 600,
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function titleFor(phase: string): string {
  switch (phase) {
    case 'idle':
      return 'Starting up…';
    case 'resolving-cli':
      return 'Looking for moxxy on your system…';
    case 'cli-missing':
      return 'moxxy CLI is not installed.';
    case 'spawning':
      return 'Starting moxxy serve…';
    case 'adopting':
      return 'Found an existing moxxy serve. Attaching…';
    case 'attaching':
      return 'Connecting to the runner…';
    case 'connected':
      return 'Connected.';
    case 'reconnecting':
      return 'Lost the runner. Reconnecting…';
    case 'failed':
      return "Couldn't connect.";
    default:
      return phase;
  }
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '70px 1fr',
        gap: '0.5rem',
        fontSize: '0.75rem',
        alignItems: 'baseline',
      }}
    >
      <span
        className="mono"
        style={{
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <span
        className="mono"
        style={{
          color: 'var(--color-text-muted)',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </span>
    </div>
  );
}
