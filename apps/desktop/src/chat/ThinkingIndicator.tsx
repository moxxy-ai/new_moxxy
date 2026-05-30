/**
 * "Thinking…" placeholder rendered between send and the agent's
 * first chunk. Once the assistant block has any text (or the turn
 * completes), the indicator disappears.
 *
 * Uses the brand avatar bobbing softly so it reads as the agent
 * doing something, not the app being stuck.
 */

import { Icon } from '@/lib/Icon';

export function ThinkingIndicator(): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        alignSelf: 'stretch',
        display: 'flex',
        gap: 12,
        maxWidth: '92%',
      }}
    >
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
        <Icon name="agent" size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>Assistant</span>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--color-primary)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            thinking…
          </span>
        </div>
        <div
          style={{
            marginTop: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            background: 'var(--color-primary-soft)',
            borderRadius: 14,
          }}
        >
          <span className="thinking-dot" style={{ animationDelay: '0ms' }} />
          <span className="thinking-dot" style={{ animationDelay: '160ms' }} />
          <span className="thinking-dot" style={{ animationDelay: '320ms' }} />
        </div>
      </div>
    </div>
  );
}
