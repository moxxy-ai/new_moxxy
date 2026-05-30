import { useState } from 'react';
import { oneLine, summarizeArgs, type ToolCallBlockData } from '@moxxy/chat-model';
import { Icon } from '@/lib/Icon';
import { preStyle, pretty } from './block-shared';

export function ToolBlock({
  name,
  input,
  outcome,
}: {
  readonly name: string;
  readonly input: unknown;
  readonly outcome: ToolCallBlockData['outcome'];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const status: 'running' | 'ok' | 'error' =
    outcome === null
      ? 'running'
      : outcome.type === 'denied'
        ? 'error'
        : outcome.ok
          ? 'ok'
          : 'error';
  const accent =
    status === 'error'
      ? 'var(--color-red)'
      : status === 'ok'
        ? 'var(--color-green)'
        : 'var(--color-primary)';
  const summary = summarizeArgs(input);
  const output = outcome && outcome.type === 'tool_result' ? outcome.output : undefined;
  const error =
    outcome === null
      ? undefined
      : outcome.type === 'denied'
        ? outcome.reason
        : outcome.error?.message;
  // A standalone (non-skill) tool call renders as its OWN top-level block,
  // mirroring the Skill block's shape: a wrench avatar + a "Tool · <name>"
  // header + status, expandable to the raw I/O. Same column rhythm as the
  // Skill group, so an orphaned tool call sits at the same level — never a
  // stray indented line.
  const statusText = status === 'ok' ? 'ok' : status === 'error' ? 'failed' : 'running';
  const tint =
    status === 'error' ? '#fee2e2' : status === 'ok' ? '#ecfdf5' : 'var(--color-primary-soft)';
  return (
    <div
      data-testid="block-tool"
      data-status={status}
      style={{ alignSelf: 'stretch', display: 'flex', gap: 12, maxWidth: '92%' }}
    >
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
            Tool
            <span className="mono" style={{ color: 'var(--color-text-dim)', fontWeight: 500, marginLeft: 6 }}>
              · {name}
            </span>
          </span>
          <span className="mono" style={{ fontSize: 11, color: accent, fontWeight: 600 }}>
            {statusText}
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
        {!open && summary && (
          <div
            className="mono"
            style={{
              marginTop: 4,
              fontSize: 11,
              color: 'var(--color-text-dim)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {oneLine(summary)}
          </div>
        )}
        {open && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <pre style={preStyle}>{pretty(input)}</pre>
            {output !== undefined && <pre style={preStyle}>{pretty(output)}</pre>}
            {error && <pre style={{ ...preStyle, color: 'var(--color-red)' }}>{error}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
