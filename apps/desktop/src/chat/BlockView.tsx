import type { Block } from '@/lib/useChat';
import { Icon } from '@/lib/Icon';
import { MarkdownBody } from './MarkdownBody';

/**
 * One transcript block. Layout follows the workspace-chat reference:
 *
 *   - user     → right-aligned periwinkle bubble, white text, no avatar.
 *   - assistant→ left-aligned: avatar + name + timestamp + plain text
 *               (no bubble) + action row (copy, thumbs, …). A blinking
 *               block-cursor at the tail of the text while streaming
 *               makes the in-flight chunks visible.
 *   - tool     → small mono summary with status-coloured left bar.
 *   - system   → centered low-key separator.
 */
export function BlockView({ block }: { readonly block: Block }): JSX.Element {
  switch (block.kind) {
    case 'user':
      return <UserBlock text={block.text} />;
    case 'assistant':
      return (
        <AssistantBlock
          text={block.text}
          streaming={block.streaming}
          stopReason={block.stopReason}
        />
      );
    case 'tool':
      return (
        <ToolBlock
          name={block.name}
          input={block.input}
          status={block.status}
          output={block.output}
          error={block.error}
        />
      );
    case 'system':
      return <SystemBlock text={block.text} tone={block.tone} />;
  }
}

function UserBlock({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      data-testid="block-user"
      style={{
        alignSelf: 'flex-end',
        maxWidth: '78%',
        padding: '12px 16px',
        background: 'var(--grad-user)',
        color: '#fff',
        borderRadius: '16px 16px 4px 16px',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.55,
        fontSize: 14.5,
        boxShadow: '0 6px 18px -10px rgba(99, 102, 241, 0.6)',
      }}
    >
      {text}
    </div>
  );
}

function AssistantBlock({
  text,
  streaming,
  stopReason,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly stopReason?: string;
}): JSX.Element {
  return (
    <div
      data-testid="block-assistant"
      data-streaming={streaming}
      style={{
        alignSelf: 'stretch',
        display: 'flex',
        gap: 12,
        maxWidth: '92%',
      }}
    >
      <Avatar />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Header streaming={streaming} />
        <div style={{ marginTop: 6 }}>
          <MarkdownBody text={text} streaming={streaming} />
        </div>
        {stopReason && stopReason !== 'end_turn' && (
          <div
            className="mono"
            style={{
              marginTop: 6,
              fontSize: 10.5,
              color: 'var(--color-text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            stop: {stopReason.replace(/_/g, ' ')}
          </div>
        )}
        {!streaming && <ActionRow text={text} />}
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
      <Icon name="agent" size={18} />
    </span>
  );
}

function Header({ streaming }: { readonly streaming: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontWeight: 600, fontSize: 13.5 }}>Assistant</span>
      {streaming ? (
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
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-primary)',
              animation: 'moxxy-pulse 1.2s ease-in-out infinite',
            }}
          />
          typing…
        </span>
      ) : (
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--color-text-dim)' }}
        >
          {hhmm(Date.now())}
        </span>
      )}
    </div>
  );
}

function ActionRow({ text }: { readonly text: string }): JSX.Element {
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* swallow; rare on Electron */
    }
  };
  return (
    <div
      style={{
        marginTop: 10,
        display: 'flex',
        gap: 2,
        color: 'var(--color-text-dim)',
      }}
    >
      <IconBtn label="Copy" onClick={() => void onCopy()}>
        <Icon name="copy" size={15} />
      </IconBtn>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        color: 'var(--color-text-dim)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-bg-card-hover)';
        e.currentTarget.style.color = 'var(--color-text)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--color-text-dim)';
      }}
    >
      {children}
    </button>
  );
}

function ToolBlock({
  name,
  input,
  status,
  output,
  error,
}: {
  readonly name: string;
  readonly input: unknown;
  readonly status: 'running' | 'ok' | 'error';
  readonly output?: unknown;
  readonly error?: string;
}): JSX.Element {
  const accent =
    status === 'error'
      ? 'var(--color-red)'
      : status === 'ok'
        ? 'var(--color-green)'
        : 'var(--color-primary)';
  const summary = summarise(input);
  return (
    <details
      data-testid="block-tool"
      data-status={status}
      className="mono"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        marginLeft: 46,
        fontSize: 12,
        color: 'var(--color-text-dim)',
        borderLeft: `2px solid ${accent}`,
        paddingLeft: 10,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
        }}
      >
        <span style={{ color: accent, fontWeight: 600 }}>[{status}]</span>
        <span style={{ color: 'var(--color-text-muted)' }}>{name}</span>
        {summary && (
          <span
            style={{
              opacity: 0.7,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 420,
            }}
          >
            {summary}
          </span>
        )}
      </summary>
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <pre style={preStyle}>{stringify(input)}</pre>
        {output !== undefined && <pre style={preStyle}>{stringify(output)}</pre>}
        {error && <pre style={{ ...preStyle, color: 'var(--color-red)' }}>{error}</pre>}
      </div>
    </details>
  );
}

function SystemBlock({
  text,
  tone,
}: {
  readonly text: string;
  readonly tone: 'info' | 'error';
}): JSX.Element {
  const color = tone === 'error' ? 'var(--color-red)' : 'var(--color-text-dim)';
  return (
    <div
      data-testid="block-system"
      role={tone === 'error' ? 'alert' : 'status'}
      className="mono"
      style={{
        alignSelf: 'center',
        fontSize: 11,
        padding: '4px 10px',
        color,
        textTransform: 'lowercase',
        letterSpacing: '0.04em',
        opacity: 0.85,
      }}
    >
      — {text} —
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  background: '#f6f7fc',
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
  if (typeof value === 'string') return value.length > 80 ? value.slice(0, 80) + '…' : value;
  try {
    const stringified = JSON.stringify(value);
    return stringified.length > 80 ? stringified.slice(0, 80) + '…' : stringified;
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

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
