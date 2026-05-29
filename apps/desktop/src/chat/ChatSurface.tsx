import { useMemo, useState } from 'react';
import { useChat } from '@/lib/useChat';
import { useDesks } from '@/lib/useDesks';
import type { ConnectionPhase } from '@shared/ipc';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { Icon } from '@/lib/Icon';
import { Modal } from '@/lib/Modal';

interface ChatSurfaceProps {
  readonly phase: ConnectionPhase;
  readonly workspaceId: string;
  readonly railOpen: boolean;
  readonly onShowRail: () => void;
}

/** Hand-tuned starter prompts shown when the transcript is empty. */
const COLD_START_SUGGESTIONS: ReadonlyArray<string> = [
  'What does this workspace contain?',
  'List the most-recently-edited files',
  'Summarise the README',
  'What commands can I run here?',
];

/**
 * Pick three short follow-ups based on the latest block. Heuristic-
 * only — no extra LLM call — because the value here is a clickable
 * suggestion, not a perfect one.
 *
 *   - Last block is assistant text → "Tell me more", "Continue",
 *     plus a topic-aware one ("Show an example of X", parsed from
 *     the assistant's last sentence's salient nouns).
 *   - Last block is a tool group → "Explain what just happened",
 *     "Re-run with different inputs".
 *   - Last block is an error → "Try a different approach".
 *   - Otherwise → generic continuation prompts.
 */
function deriveSuggestions(blocks: ReadonlyArray<import('@/lib/useChat').Block>): ReadonlyArray<string> {
  if (blocks.length === 0) return COLD_START_SUGGESTIONS.slice(0, 3);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'assistant') {
      const topic = pickTopic(b.text);
      const list = ['Continue', 'Tell me more'];
      if (topic) list.push(`Show an example of ${topic}`);
      else list.push('Show an example');
      return list.slice(0, 3);
    }
    if (b.kind === 'tool') {
      return ['Explain what just happened', 'Re-run with different inputs', 'Move on'];
    }
    if (b.kind === 'system' && b.tone === 'error') {
      return ['Try a different approach', 'Show me the logs', 'Skip this for now'];
    }
    if (b.kind === 'user') {
      return ['Tell me more', 'Continue', 'Show an example'];
    }
  }
  return COLD_START_SUGGESTIONS.slice(0, 3);
}

/** Tiny noun-phrase pluck: grab the longest backticked / capitalised
 *  / quoted span from the last sentence so the follow-up reads as
 *  contextual rather than generic. */
function pickTopic(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const last = trimmed.split(/[.!?]\s+/).filter(Boolean).pop() ?? trimmed;
  // 1. Backticked spans (almost always a thing — function, file, tool).
  const ticks = /`([^`]{2,60})`/.exec(last);
  if (ticks) return ticks[1]!.trim();
  // 2. Quoted spans.
  const quoted = /["“]([A-Za-z][^"”]{2,60})["”]/.exec(last);
  if (quoted) return quoted[1]!.trim();
  // 3. Sequences of Capitalised Words.
  const cap = /([A-Z][\w-]+(?:\s+[A-Z][\w-]+){0,4})/.exec(last);
  if (cap) return cap[1]!.trim();
  return null;
}

/**
 * Chat pane — the rightmost column. Card-style transcript with a
 * sticky header, suggested-action chips below the latest assistant
 * message, and a rounded composer floating against the pane's bottom.
 *
 * Streaming is visualised inside BlockView (a blinking block-cursor
 * trails the assistant text while chunks are still arriving). Auto-
 * scroll follows the bottom unless the user scrolls up to read.
 */
export function ChatSurface({
  phase,
  workspaceId,
  railOpen,
  onShowRail,
}: ChatSurfaceProps): JSX.Element {
  const chat = useChat(workspaceId);
  const desks = useDesks();
  const ready = phase.phase === 'connected';
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const activeDesk = desks.desks.find((d) => d.id === workspaceId);

  const filteredBlocks = useMemo(() => {
    if (!searchQuery) return chat.blocks;
    const q = searchQuery.toLowerCase();
    return chat.blocks.filter((b) => {
      if (b.kind === 'user' || b.kind === 'assistant') return b.text.toLowerCase().includes(q);
      if (b.kind === 'tool') {
        return (
          b.name.toLowerCase().includes(q) ||
          JSON.stringify(b.input).toLowerCase().includes(q)
        );
      }
      if (b.kind === 'system') return b.text.toLowerCase().includes(q);
      return false;
    });
  }, [chat.blocks, searchQuery]);

  return (
    <main className="col-main col-main--flat">
      <Header
        phase={phase}
        railOpen={railOpen}
        onShowRail={onShowRail}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        canRename={activeDesk !== undefined}
        onRename={() => setRenameOpen(true)}
      />
      {chat.blocks.length === 0 ? (
        <EmptyState ready={ready} />
      ) : (
        <Transcript blocks={filteredBlocks} sending={chat.sending} workspaceId={workspaceId} />
      )}
      {ready && !chat.sending && chat.blocks.length > 0 && (
        <SuggestedActions
          suggestions={deriveSuggestions(chat.blocks)}
          onPick={(p) => void chat.send(p)}
        />
      )}
      <Composer
        ready={ready}
        sending={chat.sending}
        activeTurnId={chat.activeTurnId}
        workspaceId={workspaceId}
        onSend={(p) => void chat.send(p)}
        onAbort={() => void chat.abort()}
      />
      {chat.error && <ErrorToast text={chat.error} />}
      {renameOpen && activeDesk && (
        <RenameWorkspaceModal
          desk={activeDesk}
          onClose={() => setRenameOpen(false)}
          onSubmit={async (name) => {
            await desks.rename(activeDesk.id, name);
            setRenameOpen(false);
          }}
        />
      )}
    </main>
  );
}

function RenameWorkspaceModal({
  desk,
  onSubmit,
  onClose,
}: {
  readonly desk: { id: string; name: string; cwd: string };
  readonly onSubmit: (name: string) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState(desk.name);
  const [busy, setBusy] = useState(false);
  const canSubmit = name.trim().length > 0 && name.trim() !== desk.name;
  return (
    <Modal title="Rename workspace" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setBusy(true);
          await onSubmit(name.trim());
          setBusy(false);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              padding: '9px 12px',
              fontSize: 14,
              color: 'var(--color-text)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
            }}
          />
        </label>
        <div
          className="mono"
          style={{
            fontSize: 11.5,
            color: 'var(--color-text-dim)',
            wordBreak: 'break-all',
          }}
        >
          {desk.cwd}
        </div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              background: '#fff',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || busy}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              color: '#fff',
              background: 'var(--color-primary-strong)',
              borderRadius: 10,
              fontWeight: 600,
              opacity: canSubmit && !busy ? 1 : 0.5,
            }}
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function Header({
  phase: _phase,
  railOpen,
  onShowRail,
  searchQuery,
  onSearchChange,
  canRename,
  onRename,
}: {
  readonly phase: ConnectionPhase;
  readonly railOpen: boolean;
  readonly onShowRail: () => void;
  readonly searchQuery: string | null;
  readonly onSearchChange: (q: string | null) => void;
  readonly canRename: boolean;
  readonly onRename: () => void;
}): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(searchQuery !== null);
  return (
    <header
      style={{
        height: 64,
        minHeight: 64,
        flexShrink: 0,
        boxSizing: 'border-box',
        padding: '0 24px',
        borderBottom: '1px solid var(--color-card-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
        Chat
      </h1>
      {/* workspace path lives in the right-hand context rail now */}
      <span style={{ flex: 1 }} />
      {searchOpen ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            autoFocus
            type="search"
            placeholder="Search transcript…"
            value={searchQuery ?? ''}
            onChange={(e) => onSearchChange(e.target.value || null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onSearchChange(null);
                setSearchOpen(false);
              }
            }}
            style={{
              padding: '6px 10px',
              fontSize: 13,
              color: 'var(--color-text)',
              border: '1px solid var(--color-card-border)',
              borderRadius: 8,
              background: '#fff',
              outline: 'none',
              width: 220,
            }}
          />
          <IconButton
            aria-label="Close search"
            onClick={() => {
              onSearchChange(null);
              setSearchOpen(false);
            }}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
      ) : (
        <IconButton aria-label="Search transcript" onClick={() => setSearchOpen(true)}>
          <Icon name="search" size={18} />
        </IconButton>
      )}
      <IconButton
        aria-label="Rename workspace"
        onClick={onRename}
        disabled={!canRename}
      >
        <Icon name="pencil" size={18} />
      </IconButton>
      {!railOpen && (
        <IconButton aria-label="Show context rail" onClick={onShowRail}>
          <Icon name="workspace" size={18} />
        </IconButton>
      )}
    </header>
  );
}

function IconButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      className="btn-icon"
      style={{
        width: 34,
        height: 34,
        borderRadius: 9,
        color: 'var(--color-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function EmptyState({ ready }: { readonly ready: boolean }): JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div>
        <img
          src="/avatar.png"
          alt=""
          aria-hidden="true"
          className={ready ? '' : 'moxxy-avatar-loader'}
          style={{
            width: 200,
            height: 'auto',
            display: 'block',
            margin: '0 auto 20px',
            imageRendering: 'pixelated',
            filter: 'drop-shadow(0 16px 18px rgba(236, 72, 153, 0.22))',
          }}
        />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {ready ? 'Ready when you are' : 'Connecting…'}
        </h2>
        <p style={{ margin: '6px 0 0', color: 'var(--color-text-dim)', fontSize: 13.5 }}>
          {ready
            ? 'Send a message to kick off this workspace.'
            : 'Waiting for the runner to come online…'}
        </p>
      </div>
    </div>
  );
}

function SuggestedActions({
  suggestions,
  onPick,
}: {
  readonly suggestions: ReadonlyArray<string>;
  readonly onPick: (prompt: string) => void;
}): JSX.Element {
  return (
    <div
      style={{
        padding: '4px 24px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--color-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        Suggested actions
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            style={{
              padding: '6px 12px',
              fontSize: 12.5,
              color: 'var(--color-text-muted)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 999,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-primary)')}
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = 'var(--color-card-border)')
            }
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ErrorToast({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        padding: '8px 14px',
        background: 'var(--color-red)',
        color: '#fff',
        borderRadius: 10,
        fontSize: 13,
        boxShadow: '0 14px 28px -16px rgba(239, 68, 68, 0.6)',
      }}
    >
      {text}
    </div>
  );
}
