import { useState } from 'react';
import { oneLine, summarizeArgs, type Block as FoldedBlock } from '@moxxy/chat-model';
import { Icon } from '@/lib/Icon';
import { preStyle } from './block-shared';

export function SubagentView({
  block,
}: {
  readonly block: Extract<FoldedBlock, { kind: 'subagent' }>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = block.completedAtMs === null && block.error === null;
  const accent = block.error
    ? 'var(--color-red)'
    : running
      ? 'var(--color-primary)'
      : 'var(--color-green)';
  // Subagents get a distinct violet tile so they read as a different KIND of
  // actor than tool calls (which are status-tinted green/pink/red).
  const tileBg = 'rgba(139, 92, 246, 0.14)';
  const tileFg = '#7c3aed';
  const statusText = running ? 'running' : block.error ? 'failed' : 'done';
  const elapsed =
    block.completedAtMs !== null ? Math.round((block.completedAtMs - block.startedAtMs) / 100) / 10 : null;
  return (
    <div
      data-testid="block-subagent"
      style={{ alignSelf: 'stretch', display: 'flex', gap: 12, maxWidth: '92%' }}
    >
      <span
        aria-hidden
        style={{
          width: 34,
          height: 34,
          flexShrink: 0,
          borderRadius: 10,
          background: tileBg,
          color: tileFg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="agent" size={18} />
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
            Agent
            <span style={{ color: 'var(--color-text-dim)', fontWeight: 500, marginLeft: 6 }}>
              · {block.label}
            </span>
          </span>
          <span className="mono" style={{ fontSize: 11, color: accent, fontWeight: 600 }}>
            {statusText}
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>
            · {block.toolCallCount} tool {block.toolCallCount === 1 ? 'call' : 'calls'}
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
          <div
            style={{
              marginTop: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12,
              color: 'var(--color-text-muted)',
            }}
          >
            <div className="mono" style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>
              {block.toolCallCount} tool {block.toolCallCount === 1 ? 'call' : 'calls'}
              {block.stopReason ? ` · ${block.stopReason}` : ''}
              {elapsed !== null ? ` · ${elapsed}s` : ''}
            </div>
            {block.toolCalls.length > 0 && (
              <ul
                className="mono"
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {block.toolCalls.map((tc, i) => {
                  const sum = oneLine(summarizeArgs(tc.input));
                  return (
                    <li
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 7,
                        alignItems: 'baseline',
                        padding: '4px 8px',
                        background: 'rgba(139, 92, 246, 0.07)',
                        borderRadius: 7,
                        fontSize: 11,
                      }}
                    >
                      <span style={{ color: tileFg, fontWeight: 600, flexShrink: 0 }}>{tc.name}</span>
                      {sum && (
                        <span
                          style={{
                            color: 'var(--color-text-dim)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {sum}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {block.error ? (
              <pre style={{ ...preStyle, color: 'var(--color-red)' }}>{block.error}</pre>
            ) : block.finalPreview ? (
              <pre style={preStyle}>{block.finalPreview}</pre>
            ) : (
              <div style={{ fontStyle: 'italic', color: 'var(--color-text-dim)' }}>
                {running ? 'Working…' : 'No output captured.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
