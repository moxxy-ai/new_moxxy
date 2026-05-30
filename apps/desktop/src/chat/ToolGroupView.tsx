/**
 * Renders a run of consecutive standalone tool calls (see
 * `chatModel.groupToolNodes`) as ONE collapsible "Tools · N" block — a wrench
 * avatar + status summary, expandable to each tool row. Mirrors
 * {@link SkillGroupView} so a burst of back-to-back Writes/fetches doesn't
 * stack into N separate top-level blocks, and reuses its ToolRow so an
 * expanded group looks identical to an expanded skill.
 */

import { useState } from 'react';
import type { ToolCallBlockData } from '@moxxy/chat-model';
import { Icon } from '@/lib/Icon';
import { ToolRow, statusOf, type ToolRowData } from './SkillGroupView';

export function ToolGroupView({
  tools,
}: {
  readonly tools: ReadonlyArray<ToolCallBlockData>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rows: ToolRowData[] = tools.map((t) => ({
    id: t.id,
    name: t.request.name,
    input: t.request.input,
    outcome: t.outcome,
  }));
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const s = statusOf(r.outcome);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const subtitle = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  const running = rows.some((r) => statusOf(r.outcome) === 'running');
  const errored = rows.some((r) => statusOf(r.outcome) === 'error');
  const accent = errored
    ? 'var(--color-red)'
    : running
      ? 'var(--color-primary)'
      : 'var(--color-green)';
  const tint = errored ? '#fee2e2' : running ? 'var(--color-primary-soft)' : '#ecfdf5';

  return (
    <div data-testid="block-tool-group" style={{ alignSelf: 'stretch', display: 'flex', gap: 12, maxWidth: '92%' }}>
      <span
        aria-hidden
        style={{
          width: 34,
          height: 34,
          flexShrink: 0,
          borderRadius: 10,
          background: tint,
          color: accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="wrench" size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '2px 0',
            width: '100%',
            textAlign: 'left',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            Tools
            <span style={{ color: 'var(--color-text-dim)', fontWeight: 500, marginLeft: 6 }}>
              · {rows.length}
            </span>
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>
            {subtitle}
          </span>
          <span style={{ flex: 1 }} />
          {running && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: accent,
                animation: 'moxxy-thinking 1.1s ease-in-out infinite',
              }}
            />
          )}
          <span
            aria-hidden
            style={{
              color: 'var(--color-text-dim)',
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform 120ms ease',
              display: 'inline-flex',
            }}
          >
            <Icon name="chevron-right" size={14} />
          </span>
        </button>
        {open && (
          <ul role="list" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
            {rows.map((r) => (
              <ToolRow key={r.id} tool={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
