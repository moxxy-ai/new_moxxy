/**
 * Renders a chat-model `skill-scope` block — a skill activation plus the
 * tools it ran — as one collapsible group. Mirrors the assistant column
 * rhythm with a brand-pink spark avatar.
 *
 *   ┌── [spark] Skill · web-research · 9 ok                       ▾
 *   │     web_fetch { "url": "https://…" }
 *   │     ...
 *   └────
 */

import { useState } from 'react';
import {
  oneLine,
  summarizeArgs,
  type Block as FoldedBlock,
  type ToolCallBlockData,
} from '@moxxy/chat-model';
import { Icon } from '@/lib/Icon';

type SkillScope = Extract<FoldedBlock, { kind: 'skill-scope' }>;

export interface ToolRowData {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly outcome: ToolCallBlockData['outcome'];
}

/** Flatten a skill scope's children into tool rows — tool-calls plus the
 *  calls inside any live-tools aggregate. Non-tool children (rare; the
 *  fold keeps assistant text at root) are dropped from the row list. */
function collectTools(children: ReadonlyArray<FoldedBlock>): ToolRowData[] {
  const out: ToolRowData[] = [];
  for (const c of children) {
    if (c.kind === 'tool-call') {
      out.push({ id: c.id, name: c.request.name, input: c.request.input, outcome: c.outcome });
    } else if (c.kind === 'live-tools') {
      for (const call of c.calls) {
        out.push({ id: call.id, name: call.request.name, input: call.request.input, outcome: call.outcome });
      }
    }
  }
  return out;
}

export function statusOf(outcome: ToolCallBlockData['outcome']): 'running' | 'ok' | 'error' {
  if (outcome === null) return 'running';
  if (outcome.type === 'denied') return 'error';
  return outcome.ok ? 'ok' : 'error';
}

export function SkillGroupView({ scope }: { readonly scope: SkillScope }): JSX.Element {
  const [open, setOpen] = useState(false);
  const tools = collectTools(scope.children);
  const counts = tools.reduce<Record<string, number>>((acc, t) => {
    const s = statusOf(t.outcome);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const subtitle = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');

  return (
    <div data-testid="block-skill" style={{ alignSelf: 'stretch', display: 'flex', gap: 12, maxWidth: '92%' }}>
      <Avatar />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', width: '100%', textAlign: 'left' }}
        >
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            Skill
            <span style={{ color: 'var(--color-text-dim)', fontWeight: 500, marginLeft: 6 }}>
              · {scope.skillEvent.name}
            </span>
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>
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
        {!open && (
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-dim)', fontStyle: 'italic' }}>
            {scope.skillEvent.reason.replace(/_/g, ' ')}
          </div>
        )}
        {open && (
          <ul role="list" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
            {tools.map((t) => (
              <ToolRow key={t.id} tool={t} />
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
        background: 'var(--color-primary-soft)',
        color: 'var(--color-primary-strong)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Icon name="spark" size={18} />
    </span>
  );
}

export function ToolRow({ tool }: { readonly tool: ToolRowData }): JSX.Element {
  const [open, setOpen] = useState(false);
  const status = statusOf(tool.outcome);
  const accent =
    status === 'error' ? 'var(--color-red)' : status === 'ok' ? 'var(--color-green)' : 'var(--color-primary)';
  const tint = status === 'error' ? '#fee2e2' : status === 'ok' ? '#ecfdf5' : 'var(--color-primary-soft)';
  const summary = summarizeArgs(tool.input);
  const output = tool.outcome && tool.outcome.type === 'tool_result' ? tool.outcome.output : undefined;
  const error =
    tool.outcome === null
      ? undefined
      : tool.outcome.type === 'denied'
        ? tool.outcome.reason
        : tool.outcome.error?.message;
  return (
    <li
      style={{
        background: tint,
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
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, color: 'var(--color-text)', textAlign: 'left' }}
      >
        <span style={{ color: accent, fontWeight: 600 }}>[{status}]</span>
        <span style={{ fontWeight: 600 }}>{tool.name}</span>
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
            {oneLine(summary)}
          </span>
        )}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <pre style={preStyle}>{pretty(tool.input)}</pre>
          {output !== undefined && <pre style={preStyle}>{pretty(output)}</pre>}
          {error && <pre style={{ ...preStyle, color: 'var(--color-red)' }}>{error}</pre>}
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

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
