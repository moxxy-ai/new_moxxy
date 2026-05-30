import { useState } from 'react';
import { useContextUsage } from '@/lib/useContextUsage';
import { UsageModal } from './UsageModal';

/**
 * Compact context-fill gauge for the composer footer. Shows the share of
 * the model's context window the conversation currently occupies (escalating
 * pink → amber → red), and opens the {@link UsageModal} on click for the full
 * token breakdown plus a one-tap compaction.
 *
 * Shown as soon as the active model's context window is known (on connect) —
 * at 0% before the first reply, filling as the conversation grows. Hidden
 * only when the window size can't be resolved (no model/provider yet).
 */
export function ContextMeter({ workspaceId }: { readonly workspaceId: string }): JSX.Element | null {
  const usage = useContextUsage(workspaceId);
  const [open, setOpen] = useState(false);

  if (usage.fraction == null) return null;

  const f = usage.fraction;
  const color = f >= 0.85 ? 'var(--color-red)' : f >= 0.6 ? 'var(--color-amber)' : 'var(--color-primary)';
  const label = `${Math.round(f * 100)}%`;

  return (
    <>
      <button
        type="button"
        className="btn-chip"
        aria-label={`Context ${label} used — open usage`}
        title={`Context ${label} used · click for usage & compaction`}
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '6px 10px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 10,
          background: '#fff',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 30,
            height: 5,
            borderRadius: 999,
            background: 'rgba(148, 163, 184, 0.22)',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${Math.round(f * 100)}%`,
              height: '100%',
              borderRadius: 999,
              background: color,
            }}
          />
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{label}</span>
      </button>
      {open && <UsageModal usage={usage} workspaceId={workspaceId} onClose={() => setOpen(false)} />}
    </>
  );
}
