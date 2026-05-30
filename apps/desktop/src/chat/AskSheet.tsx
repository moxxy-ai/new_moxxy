import { useState } from 'react';
import { summarizeArgs, oneLine } from '@moxxy/chat-model';
import type { AskRequest, ApprovalRequest, ApprovalOption } from '@moxxy/desktop-ipc-contract';
import { Icon } from '@/lib/Icon';
import { askStore } from '@/lib/askStore';

/**
 * Bottom sheet rendered above the composer when the runner needs a decision —
 * a tool-call permission gate or a loop-strategy approval (plan-execute,
 * BMAD, …). The runner blocks on the answer, so this is modal-in-spirit: the
 * user picks an option and we reply over `ask.respond`, unblocking the turn.
 */
export function AskSheet({ ask }: { readonly ask: AskRequest }): JSX.Element {
  return ask.kind === 'approval' && ask.approval ? (
    <ApprovalSheet ask={ask} approval={ask.approval} />
  ) : (
    <PermissionSheet ask={ask} />
  );
}

function PermissionSheet({ ask }: { readonly ask: AskRequest }): JSX.Element {
  const tool = ask.tool;
  const summary = tool ? oneLine(summarizeArgs(tool.input)) : '';
  const decide = (mode: 'deny' | 'allow_session' | 'allow_always'): void =>
    askStore.respond(ask.requestId, { mode });
  return (
    <Sheet icon="wrench" title="Permission required" accent="var(--color-primary)">
      <p style={bodyTextStyle}>
        The agent wants to run <strong style={{ color: 'var(--color-text)' }}>{tool?.name}</strong>
        {tool?.description ? ` — ${tool.description}` : ''}.
      </p>
      {summary && <pre style={preStyle}>{summary}</pre>}
      <Buttons>
        <SheetButton tone="danger" onClick={() => decide('deny')}>
          Deny
        </SheetButton>
        <SheetButton tone="neutral" onClick={() => decide('allow_session')}>
          Allow
        </SheetButton>
        <SheetButton tone="primary" onClick={() => decide('allow_always')}>
          Always allow
        </SheetButton>
      </Buttons>
    </Sheet>
  );
}

function ApprovalSheet({
  ask,
  approval,
}: {
  readonly ask: AskRequest;
  readonly approval: ApprovalRequest;
}): JSX.Element {
  // When an option asks for follow-up text we switch to a small compose step.
  const [textOption, setTextOption] = useState<ApprovalOption | null>(null);
  const [text, setText] = useState('');

  const pick = (opt: ApprovalOption): void => {
    if (opt.requestsText) {
      setTextOption(opt);
      return;
    }
    askStore.respond(ask.requestId, { optionId: opt.id });
  };
  const sendText = (): void =>
    askStore.respond(ask.requestId, { optionId: textOption!.id, text: text.trim() });

  return (
    <Sheet icon="spark" title={approval.title} accent="var(--color-primary)">
      {approval.body.trim() && <pre style={preStyle}>{approval.body.trim()}</pre>}
      {textOption ? (
        <>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={textOption.textPrompt ?? 'Add details…'}
            rows={3}
            style={{
              width: '100%',
              resize: 'vertical',
              padding: '10px 12px',
              fontSize: 13.5,
              lineHeight: 1.5,
              color: 'var(--color-text)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <Buttons>
            <SheetButton tone="neutral" onClick={() => setTextOption(null)}>
              Back
            </SheetButton>
            <SheetButton tone="primary" onClick={sendText} disabled={text.trim().length === 0}>
              {textOption.label}
            </SheetButton>
          </Buttons>
        </>
      ) : (
        <Buttons>
          {approval.options.map((opt) => (
            <SheetButton
              key={opt.id}
              tone={opt.danger ? 'danger' : opt.id === approval.defaultOptionId ? 'primary' : 'neutral'}
              title={opt.description}
              onClick={() => pick(opt)}
            >
              {opt.label}
            </SheetButton>
          ))}
        </Buttons>
      )}
    </Sheet>
  );
}

// ---- shared chrome --------------------------------------------------------

function Sheet({
  icon,
  title,
  accent,
  children,
}: {
  readonly icon: 'wrench' | 'spark';
  readonly title: string;
  readonly accent: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="anim-fade-up"
      style={{
        margin: '0 24px 8px',
        background: '#fff',
        border: `1px solid ${accent}`,
        borderRadius: 14,
        boxShadow: '0 18px 40px -22px rgba(15, 23, 42, 0.4)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            borderRadius: 8,
            background: 'var(--color-primary-soft)',
            color: 'var(--color-primary-strong)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={15} />
        </span>
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: 'var(--color-text)' }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Buttons({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
      {children}
    </div>
  );
}

function SheetButton({
  tone,
  onClick,
  disabled,
  title,
  children,
}: {
  readonly tone: 'neutral' | 'primary' | 'danger';
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  const palette =
    tone === 'primary'
      ? { bg: 'var(--color-primary-strong)', color: '#fff', border: 'transparent' }
      : tone === 'danger'
        ? { bg: '#fff', color: 'var(--color-red)', border: 'var(--color-card-border)' }
        : { bg: '#fff', color: 'var(--color-text-muted)', border: 'var(--color-card-border)' };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(title ? { title } : {})}
      style={{
        padding: '8px 15px',
        fontSize: 13,
        fontWeight: 600,
        color: palette.color,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

const bodyTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.55,
  color: 'var(--color-text-muted)',
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  background: '#f7f8fc',
  border: '1px solid var(--color-card-border)',
  borderRadius: 8,
  fontSize: 11.5,
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflow: 'auto',
  color: 'var(--color-text)',
};
