import { useEffect, useState } from 'react';
import type { MoxxyEvent } from '@moxxy/sdk';
import {
  oneLine,
  summarizeArgs,
  type Block as FoldedBlock,
  type ToolCallBlockData,
} from '@moxxy/chat-model';
import { speak, cancelSpeech, isSpeechSupported } from '@/lib/speech';
import { Icon } from '@/lib/Icon';
import { MarkdownBody } from './MarkdownBody';
import { SkillGroupView } from './SkillGroupView';

/**
 * One transcript block, rendered from the shared @moxxy/chat-model fold.
 *
 *   - event(user_prompt)      → right-aligned periwinkle bubble.
 *   - event(assistant_message)→ avatar + name + markdown + copy action.
 *   - event(error/abort)      → centered system note.
 *   - tool-call               → mono summary with status-coloured bar.
 *   - skill-scope             → SkillGroupView (banner + nested children).
 *   - subagent                → one-line agent row.
 *   - live-tools              → each call rendered as a tool row.
 *
 * The in-flight streaming assistant text is NOT a block — Transcript
 * renders it via {@link StreamingAssistant} at the tail.
 */
export function BlockView({ block }: { readonly block: FoldedBlock }): JSX.Element | null {
  switch (block.kind) {
    case 'event':
      return <EventBlockView event={block.event} />;
    case 'tool-call':
      return (
        <ToolBlock
          name={block.request.name}
          input={block.request.input}
          outcome={block.outcome}
        />
      );
    case 'skill-scope':
      return <SkillGroupView scope={block} />;
    case 'subagent':
      return <SubagentView block={block} />;
    case 'live-tools':
      return (
        <>
          {block.calls.map((c) => (
            <ToolBlock
              key={c.id}
              name={c.request.name}
              input={c.request.input}
              outcome={c.outcome}
            />
          ))}
        </>
      );
  }
}

function EventBlockView({ event }: { readonly event: MoxxyEvent }): JSX.Element | null {
  switch (event.type) {
    case 'user_prompt':
      return (
        <UserBlock
          text={event.text}
          attachments={event.attachments?.map((a) => a.name ?? a.kind)}
        />
      );
    case 'assistant_message':
      return <AssistantBlock text={event.content} streaming={false} stopReason={event.stopReason} />;
    case 'error':
      return <SystemBlock text={event.message} tone="error" />;
    case 'abort':
      return <SystemBlock text={`aborted: ${event.reason}`} tone="info" />;
    default:
      // skill_invoked is consumed into skill-scope; everything else is
      // bookkeeping the chat surface doesn't render.
      return null;
  }
}

/** Live assistant text while chunks are still arriving — rendered by
 *  Transcript from the store's separate `streamingText`, not a block. */
export function StreamingAssistant({ text }: { readonly text: string }): JSX.Element {
  return <AssistantBlock text={text} streaming />;
}

function UserBlock({
  text,
  attachments,
}: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<string>;
}): JSX.Element {
  const hasAttachments = (attachments?.length ?? 0) > 0;
  return (
    <div
      data-testid="block-user"
      style={{
        alignSelf: 'flex-end',
        maxWidth: '78%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      {hasAttachments && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
          {attachments!.map((name, i) => (
            <span
              key={`${name}-${i}`}
              title={name}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: '#fff',
                border: '1px solid var(--color-primary)',
                borderRadius: 999,
                fontSize: 12,
                color: 'var(--color-primary-strong)',
                fontWeight: 600,
                maxWidth: 280,
              }}
            >
              <Icon name="attach" size={12} />
              <span
                className="mono"
                style={{
                  maxWidth: 220,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                @{name}
              </span>
            </span>
          ))}
        </div>
      )}
      {(text.length > 0 || !hasAttachments) && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--grad-user)',
            color: '#fff',
            borderRadius: '16px 16px 4px 16px',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.55,
            fontSize: 14.5,
            boxShadow: '0 6px 18px -10px rgba(236, 72, 153, 0.55)',
          }}
        >
          {text}
        </div>
      )}
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
      style={{ alignSelf: 'stretch', display: 'flex', gap: 12, maxWidth: '92%' }}
    >
      <Avatar />
      <div style={{ flex: 1, minWidth: 0 }}>
        <AssistantHeader streaming={streaming} />
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

function AssistantHeader({ streaming }: { readonly streaming: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontWeight: 600, fontSize: 13.5 }}>Assistant</span>
      {streaming && (
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
      )}
    </div>
  );
}

function ActionRow({ text }: { readonly text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow; rare on Electron */
    }
  };

  const onSpeak = (): void => {
    if (speaking) {
      cancelSpeech();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    speak(text, {
      onend: () => setSpeaking(false),
      onerror: () => setSpeaking(false),
    });
  };

  // Stop any in-flight speech if this block unmounts (workspace switch,
  // clear, or scroll out of the virtualised window).
  useEffect(() => () => cancelSpeech(), []);

  return (
    <div
      style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 2, color: 'var(--color-text-dim)' }}
    >
      <ActBtn label={copied ? 'Copied!' : 'Copy'} active={copied} activeColor="var(--color-green)" onClick={() => void onCopy()}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </ActBtn>
      {isSpeechSupported() && (
        <ActBtn
          label={speaking ? 'Stop' : 'Read aloud'}
          active={speaking}
          activeColor="var(--color-primary)"
          onClick={onSpeak}
        >
          <Icon name={speaking ? 'stop' : 'speaker'} size={15} />
        </ActBtn>
      )}
      <span aria-hidden style={{ width: 1, height: 14, background: 'var(--color-card-border)', margin: '0 5px' }} />
      <ActBtn
        label="Good response"
        active={feedback === 'up'}
        activeColor="var(--color-green)"
        onClick={() => setFeedback((f) => (f === 'up' ? null : 'up'))}
      >
        <Icon name="thumbs-up" size={15} />
      </ActBtn>
      <ActBtn
        label="Bad response"
        active={feedback === 'down'}
        activeColor="var(--color-red)"
        onClick={() => setFeedback((f) => (f === 'down' ? null : 'down'))}
      >
        <Icon name="thumbs-down" size={15} />
      </ActBtn>
    </div>
  );
}

function ActBtn({
  label,
  active,
  activeColor,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly activeColor: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="btn-icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        color: active ? activeColor : 'var(--color-text-dim)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

function ToolBlock({
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

function SubagentView({
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
  const tint = block.error ? '#fee2e2' : running ? 'var(--color-primary-soft)' : '#ecfdf5';
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
          background: tint,
          color: accent,
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

/** Pretty 2-space JSON for the expanded tool body (distinct from
 *  chat-model's single-line `stringify`, which feeds summaries). */
function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
