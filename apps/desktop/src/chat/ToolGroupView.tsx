/**
 * Renders a run of consecutive tool calls as a single grouped block.
 *
 *   ┌── [icon] Tools (3) · 2 ok · 1 running                         ▾
 *   │     [ok]    grep        {"pattern":"foo"}                      ↗
 *   │     [ok]    read_file   {"path":"src/index.ts"}                ↗
 *   │     [run]   web_fetch   {"url":"https://…"}
 *   └────
 *
 * Mirrors the assistant block's avatar+meta layout so tool activity
 * sits in the same column rhythm as messages instead of as a free-
 * floating mono strip.
 */

import { useState } from 'react';
import type { Block } from '@/lib/useChat';
import { Icon } from '@/lib/Icon';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

export function ToolGroupView({
  tools,
}: {
  readonly tools: ReadonlyArray<ToolBlock>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const counts = tools.reduce(
    (acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const subtitle = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');

  return (
    <div
      data-testid="block-tools"
      style={{
        alignSelf: 'stretch',
        display: 'flex',
        gap: 12,
        maxWidth: '92%',
      }}
    >
      <Avatar />
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
            {tools.length === 1 ? 'Tool' : 'Tools'}
            <span style={{ color: 'var(--color-text-dim)', fontWeight: 500, marginLeft: 6 }}>
              ({tools.length})
            </span>
          </span>
          <span
            className="mono"
            style={{ fontSize: 11, color: 'var(--color-text-dim)' }}
          >
            {subtitle}
          </span>
          <span style={{ flex: 1 }} />
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
            {tools.map((t) => (
              <ToolRow key={t.id} block={t} startOpen={false} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Avatar(): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        background: '#ecfdf5',
        color: 'var(--color-green)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Icon name="plug" size={18} />
    </span>
  );
}

function ToolRow({
  block,
  startOpen,
}: {
  readonly block: ToolBlock;
  readonly startOpen: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const accent =
    block.status === 'error'
      ? 'var(--color-red)'
      : block.status === 'ok'
        ? 'var(--color-green)'
        : 'var(--color-primary)';
  const tone =
    block.status === 'error'
      ? '#fee2e2'
      : block.status === 'ok'
        ? '#ecfdf5'
        : 'var(--color-primary-soft)';
  const summary = summarise(block.input);

  return (
    <li
      data-testid="tool-row"
      data-status={block.status}
      style={{
        background: tone,
        border: '1px solid var(--color-card-border)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 10,
        padding: '8px 10px',
        marginTop: 4,
        fontSize: 12.5,
        fontFamily: 'var(--font-mono)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          gap: 8,
          color: 'var(--color-text)',
          textAlign: 'left',
        }}
      >
        <span style={{ color: accent, fontWeight: 600 }}>[{block.status}]</span>
        <span style={{ fontWeight: 600 }}>{block.name}</span>
        {summary && (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              color: 'var(--color-text-dim)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <pre style={preStyle}>{stringify(block.input)}</pre>
          {block.output !== undefined && (
            <pre style={preStyle}>{stringify(block.output)}</pre>
          )}
          {block.error && (
            <pre style={{ ...preStyle, color: 'var(--color-red)' }}>{block.error}</pre>
          )}
        </div>
      )}
    </li>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  background: '#fff',
  border: '1px solid var(--color-card-border)',
  borderRadius: 6,
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 280,
  overflow: 'auto',
};

function summarise(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.length > 100 ? value.slice(0, 100) + '…' : value;
  try {
    const s = JSON.stringify(value);
    return s.length > 100 ? s.slice(0, 100) + '…' : s;
  } catch {
    return '';
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
