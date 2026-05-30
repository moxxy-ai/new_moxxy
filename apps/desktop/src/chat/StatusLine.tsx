import type { ConnectionPhase } from '@moxxy/desktop-ipc-contract';

interface StatusLineProps {
  readonly phase: ConnectionPhase;
}

/**
 * Top-of-pane status line — mirrors the TUI's StatusLine. Shows
 * connection health + provider + model + mode in a single mono row.
 */
export function StatusLine({ phase }: StatusLineProps): JSX.Element {
  const connected = phase.phase === 'connected';
  const dot = connected ? 'var(--color-green)' : 'var(--color-text-dim)';
  const provider = connected ? phase.activeProvider : null;
  const mode = connected ? phase.activeMode : null;
  return (
    <header
      data-testid="status-line"
      style={{
        padding: '0.65rem 2rem',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        fontSize: '0.78rem',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dot,
          boxShadow: connected ? '0 0 8px var(--color-green)' : 'none',
        }}
      />
      <span style={{ fontWeight: 600 }}>moxxy</span>
      <Slot label="provider" value={provider} />
      <Slot label="mode" value={mode} />
      <span style={{ flex: 1 }} />
      <span className="mono" style={{ color: 'var(--color-text-dim)' }}>
        {phase.phase}
      </span>
    </header>
  );
}

function Slot({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): JSX.Element {
  return (
    <span
      className="mono"
      style={{
        color: value ? 'var(--color-text-muted)' : 'var(--color-text-dim)',
      }}
    >
      <span style={{ opacity: 0.6 }}>{label}:</span> {value ?? '—'}
    </span>
  );
}
