import type { Extension } from '@/lib/useChat';
import { chatStore } from '@/lib/chatStore';
import { Icon } from '@/lib/Icon';
import { MarkdownBody } from './MarkdownBody';

/**
 * Desktop-only timeline cards that have no runner event behind them:
 * slash-command result cards (`action_result`) and locally-generated
 * notices (turn-failure errors). Both are dismissable.
 */
export function ExtensionCard({
  ext,
  workspaceId,
}: {
  readonly ext: Extension;
  readonly workspaceId?: string;
}): JSX.Element {
  const dismiss = (): void => {
    if (workspaceId) chatStore.dispatch(workspaceId, { type: 'dismiss_block', blockId: ext.id });
  };
  if (ext.kind === 'notice') {
    const accent = ext.tone === 'error' ? 'var(--color-red)' : 'var(--color-text-dim)';
    return (
      <div
        data-testid="block-system"
        role={ext.tone === 'error' ? 'alert' : 'status'}
        className="mono"
        style={{
          alignSelf: 'center',
          fontSize: 11,
          padding: '4px 10px',
          color: accent,
          letterSpacing: '0.04em',
          opacity: 0.9,
          display: 'inline-flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <span>— {ext.text} —</span>
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="btn-icon" style={dismissBtn}>
          <Icon name="x" size={11} />
        </button>
      </div>
    );
  }
  const accent =
    ext.tone === 'error'
      ? 'var(--color-red)'
      : ext.tone === 'notice'
        ? 'var(--color-amber)'
        : 'var(--color-primary-strong)';
  const tint = ext.tone === 'error' ? '#fef2f2' : ext.tone === 'notice' ? '#fffbeb' : '#fdf2f8';
  return (
    <article
      data-testid="block-action"
      style={{
        alignSelf: 'stretch',
        maxWidth: '92%',
        background: '#fff',
        border: '1px solid var(--color-card-border)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 12,
        boxShadow: 'var(--color-card-shadow)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: tint,
          borderBottom: ext.text ? '1px solid var(--color-card-border)' : 'none',
        }}
      >
        <span aria-hidden style={{ color: accent, display: 'inline-flex', alignItems: 'center' }}>
          <Icon name={ext.tone === 'error' ? 'x' : ext.tone === 'notice' ? 'bell' : 'spark'} size={14} />
        </span>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: accent,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Action · {ext.commandName}
        </span>
        {ext.argsLine && (
          <span
            className="mono"
            title={ext.argsLine}
            style={{
              fontSize: 11,
              color: 'var(--color-text-dim)',
              maxWidth: 240,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {ext.argsLine}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="btn-icon" style={dismissBtn}>
          <Icon name="x" size={12} />
        </button>
      </header>
      {ext.text.trim() && (
        <div style={{ padding: '12px 14px', fontSize: 13.5 }}>
          {ext.tone === 'error' ? (
            <pre
              className="mono"
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--color-red)',
                fontSize: 12,
              }}
            >
              {ext.text}
            </pre>
          ) : (
            <MarkdownBody text={ext.text} />
          )}
        </div>
      )}
    </article>
  );
}

const dismissBtn: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  color: 'var(--color-text-dim)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
