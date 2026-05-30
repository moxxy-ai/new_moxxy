/**
 * Stage 3a: mini-text — the 360×220 compact composer (input + send) plus
 * a single-line preview of the latest turn. Sending invokes the same
 * runner turn as the main window (bidirectional sync).
 *
 * Hosts the mini-text-only line primitives (header, thinking / latest /
 * idle preview lines) since nothing else consumes them.
 */

import { useState } from 'react';
import { api } from '@/lib/api';
import { useChat } from '@/lib/useChat';
import { Dot, LogoMark } from './focus-primitives';
import { ChevronLeftIcon, SendIcon, WindowIcon } from './focus-icons';
import { useLatestBlock } from './useLatestBlock';
import type { LatestBlock } from './useLatestBlock';
import { style } from './focus-styles';

export function MiniText({
  workspaceId,
  onBack,
}: {
  readonly workspaceId: string | null;
  readonly onBack: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const chat = useChat(workspaceId);
  const latest = useLatestBlock(workspaceId);

  const submit = (): void => {
    if (!workspaceId || !draft.trim()) return;
    void chat.send(draft.trim());
    setDraft('');
  };

  return (
    <div style={style.panel}>
      <MiniHeader title="Text" onBack={onBack} />
      <div style={style.panelBody}>
        {chat.sending ? (
          <ThinkingLine />
        ) : latest ? (
          <LatestLine block={latest} />
        ) : (
          <IdleLine
            label={workspaceId ? 'Type a quick prompt below.' : 'No active workspace.'}
          />
        )}
      </div>
      <form
        style={style.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          autoFocus
          placeholder={workspaceId ? 'Ask Moxxy…' : 'No active workspace'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!workspaceId}
          style={style.input}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!workspaceId || !draft.trim()}
          style={style.send}
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}

// ---- Mini-text line primitives -------------------------------------------

function MiniHeader({
  title,
  onBack,
}: {
  readonly title: string;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <header style={style.miniHeader}>
      <button type="button" onClick={onBack} style={style.headerButton} aria-label="Back">
        <ChevronLeftIcon />
      </button>
      <div style={style.miniTitle}>
        <LogoMark size={16} />
        <span>{title}</span>
      </div>
      <button
        type="button"
        onClick={() => void api().invoke('focus.restoreMain').catch(() => undefined)}
        style={style.headerButton}
        aria-label="Open main window"
      >
        <WindowIcon />
      </button>
    </header>
  );
}

function ThinkingLine(): JSX.Element {
  return (
    <div style={style.lineRow}>
      <Dot delay={0} />
      <Dot delay={160} />
      <Dot delay={320} />
      <span style={{ color: '#ec4899', fontWeight: 600, fontSize: 13 }}>working…</span>
    </div>
  );
}

function LatestLine({ block }: { readonly block: LatestBlock }): JSX.Element {
  const prefix = block.who === 'user' ? 'you · ' : '';
  return (
    <div
      style={{
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: 'block',
        fontSize: 13,
        color: '#0f172a',
        lineHeight: 1.4,
        width: '100%',
      }}
      title={block.text}
    >
      {prefix && (
        <span style={{ opacity: 0.55, fontWeight: 600, marginRight: 4 }}>{prefix}</span>
      )}
      {block.text.trim().split(/\n/)[0]}
    </div>
  );
}

function IdleLine({ label }: { readonly label: string }): JSX.Element {
  return (
    <div style={{ fontSize: 12.5, color: '#64748b', fontStyle: 'italic' }}>{label}</div>
  );
}
