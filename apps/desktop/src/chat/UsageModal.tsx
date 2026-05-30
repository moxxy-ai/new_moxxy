import { useState } from 'react';
import { Modal } from '@/lib/Modal';
import { api } from '@/lib/api';
import { Icon } from '@/lib/Icon';
import { chatStore } from '@/lib/chatStore';
import type { ContextUsage } from '@/lib/useContextUsage';

/** Compact token formatter — 1.2k / 3.40M / 812. */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

function fillColor(f: number): string {
  return f >= 0.85 ? 'var(--color-red)' : f >= 0.6 ? 'var(--color-amber)' : 'var(--color-primary)';
}

/**
 * `Usage & context` modal — opened from the composer's context meter.
 *
 * Top: live context-window fill (the last call's prompt size vs the model's
 * window). Middle: this session's prompt composition (cache read / fresh /
 * cache write) + cache savings, with a per-call growth sparkline. Bottom: a
 * one-click "Compact context now" that runs the runner's `/compact` command;
 * the freed space shows up on the next message (compaction rewrites history,
 * the gauge reflects it when the next prompt is sent).
 */
export function UsageModal({
  usage,
  workspaceId,
  onClose,
}: {
  readonly usage: ContextUsage;
  readonly workspaceId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const [compacting, setCompacting] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const s = usage.summary;
  const f = usage.fraction;
  const freshFrac = s.totalPrompt > 0 ? s.totalInput / s.totalPrompt : 0;
  const readFrac = s.totalPrompt > 0 ? s.totalCacheRead / s.totalPrompt : 0;
  const writeFrac = s.totalPrompt > 0 ? s.totalCacheCreation / s.totalPrompt : 0;

  const onCompact = async (): Promise<void> => {
    setCompacting(true);
    setNote(null);
    // Lock the composer for the whole workspace while the runner summarizes —
    // a mid-compaction send would race the context rewrite.
    chatStore.setCompacting(workspaceId, true);
    try {
      const r = await api().invoke('session.runCommand', {
        workspaceId,
        name: 'compact',
        args: '',
      });
      if (r.kind === 'error') {
        setNote({ kind: 'error', text: r.message ?? 'compaction failed' });
      } else {
        setNote({ kind: 'ok', text: r.text ?? 'context compacted' });
      }
    } catch {
      setNote({ kind: 'error', text: 'compaction failed' });
    } finally {
      setCompacting(false);
      chatStore.setCompacting(workspaceId, false);
    }
  };

  return (
    <Modal title="Usage & context" onClose={onClose} width={460}>
      <Section title="Context window">
        {f != null ? (
          <>
            <Bar frac={f} color={fillColor(f)} />
            <Meta>
              <strong style={{ color: fillColor(f) }}>{pct(f)}</strong>
              {`  ·  ${fmt(usage.contextTokens ?? 0)} / ${fmt(usage.contextWindow ?? 0)} tokens`}
            </Meta>
          </>
        ) : (
          <Dim>The context fill appears once the first response lands.</Dim>
        )}
      </Section>

      {s.calls > 0 && (
        <Section title="Prompt composition" subtitle={`${s.calls} calls · ${fmt(s.totalPrompt)} prompt`}>
          <CompRow label="Cache read" frac={readFrac} value={s.totalCacheRead} color="var(--color-green)" />
          <CompRow label="Fresh input" frac={freshFrac} value={s.totalInput} color="var(--color-primary)" />
          <CompRow label="Cache write" frac={writeFrac} value={s.totalCacheCreation} color="var(--color-amber)" />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 4,
              fontSize: 12,
              color: 'var(--color-text-muted)',
            }}
          >
            <span>
              Cache hit <strong>{pct(s.cacheHitRate)}</strong>
            </span>
            {s.savedRatio > 0.005 ? (
              <span style={{ color: 'var(--color-green)', fontWeight: 600 }}>
                saved {pct(s.savedRatio)} on input
              </span>
            ) : (
              <span style={{ color: 'var(--color-text-dim)' }}>no cache savings yet</span>
            )}
          </div>
          {usage.perCall.length >= 2 && <Sparkline series={usage.perCall} />}
        </Section>
      )}

      <footer style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
        {note && (
          <p
            role="status"
            style={{
              margin: 0,
              fontSize: 12.5,
              color: note.kind === 'error' ? 'var(--color-red)' : 'var(--color-green)',
            }}
          >
            {note.text}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-dim)', lineHeight: 1.4 }}>
            Summarises older turns to free up the window. Takes effect on your next message.
          </span>
          <button
            type="button"
            onClick={() => void onCompact()}
            disabled={compacting}
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--color-primary-strong)',
              borderRadius: 10,
              opacity: compacting ? 0.6 : 1,
            }}
          >
            <Icon name={compacting ? 'rotate' : 'spark'} size={15} />
            {compacting ? 'Compacting…' : 'Compact now'}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--color-text)' }}>{title}</h3>
        {subtitle && (
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--color-text-dim)' }}>
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** Filled-portion-only bar — empty track reads as empty, not a solid block. */
function Bar({ frac, color }: { readonly frac: number; readonly color: string }): JSX.Element {
  return (
    <div
      style={{
        height: 8,
        borderRadius: 999,
        background: 'rgba(148, 163, 184, 0.18)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(1, frac)) * 100}%`,
          height: '100%',
          borderRadius: 999,
          background: color,
          transition: 'width 240ms ease',
        }}
      />
    </div>
  );
}

function CompRow({
  label,
  frac,
  value,
  color,
}: {
  readonly label: string;
  readonly frac: number;
  readonly value: number;
  readonly color: string;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 86, flexShrink: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>
        {label}
      </span>
      <div style={{ flex: 1 }}>
        <Bar frac={frac} color={color} />
      </div>
      <span
        className="mono"
        style={{ width: 76, flexShrink: 0, textAlign: 'right', fontSize: 11, color: 'var(--color-text-dim)' }}
      >
        {pct(frac)} · {fmt(value)}
      </span>
    </div>
  );
}

/** Per-call prompt-size sparkline — flat = bounded, rising = growing. */
function Sparkline({ series }: { readonly series: ReadonlyArray<number> }): JSX.Element {
  const tail = series.slice(-44);
  const max = Math.max(...tail, 1);
  const growing = tail.length >= 4 && tail[tail.length - 1]! > tail[0]! * 1.5;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, height: 22 }}>
        {tail.map((v, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${Math.max(8, (v / max) * 100)}%`,
              background: 'var(--color-primary)',
              opacity: 0.35 + (v / max) * 0.55,
              borderRadius: 1,
            }}
          />
        ))}
      </div>
      <span
        style={{
          flexShrink: 0,
          fontSize: 11,
          fontWeight: 600,
          color: growing ? 'var(--color-amber)' : 'var(--color-green)',
        }}
      >
        {growing ? 'growing' : 'bounded'}
      </span>
    </div>
  );
}

function Meta({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{children}</div>;
}

function Dim({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-text-dim)' }}>{children}</p>;
}
