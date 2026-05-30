import { useMemo, useState } from 'react';
import { useChat } from '@/lib/useChat';
import { useDesks } from '@/lib/useDesks';
import type { ConnectionPhase } from '@moxxy/desktop-ipc-contract';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { AskSheet } from './AskSheet';
import { useActiveAsk } from '@/lib/askStore';
import { Header } from './chat-surface/Header';
import { ChatLoading } from './chat-surface/ChatLoading';
import { EmptyState } from './chat-surface/EmptyState';
import { SuggestedActions } from './chat-surface/SuggestedActions';
import { ErrorToast } from './chat-surface/ErrorToast';
import { RenameWorkspaceModal } from './chat-surface/RenameWorkspaceModal';
import { deriveSuggestions } from './chat-surface/suggestions';

interface ChatSurfaceProps {
  readonly phase: ConnectionPhase;
  readonly workspaceId: string;
  readonly railOpen: boolean;
  readonly onShowRail: () => void;
}

/** Stable empty reference for the searching code path (no extensions
 *  while a search filter is active). */
const EMPTY_EXTENSIONS: ReadonlyArray<import('@/lib/useChat').Extension> = Object.freeze([]);

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
  const activeAsk = useActiveAsk(workspaceId);
  const ready = phase.phase === 'connected';
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const activeDesk = desks.desks.find((d) => d.id === workspaceId);

  const filteredEvents = useMemo(() => {
    if (!searchQuery) return chat.events;
    const q = searchQuery.toLowerCase();
    return chat.events.filter((e) => {
      if (e.type === 'user_prompt') return e.text.toLowerCase().includes(q);
      if (e.type === 'assistant_message') return e.content.toLowerCase().includes(q);
      if (e.type === 'tool_call_requested') {
        return (
          e.name.toLowerCase().includes(q) ||
          JSON.stringify(e.input).toLowerCase().includes(q)
        );
      }
      if (e.type === 'error') return e.message.toLowerCase().includes(q);
      return false;
    });
  }, [chat.events, searchQuery]);

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
      {/* Keyed by workspace so the message area cross-fades on switch
       *  instead of snapping — masks the content swap flicker. */}
      <div
        key={workspaceId}
        className="anim-fade-in"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {chat.loading ? (
          <ChatLoading />
        ) : chat.isEmpty ? (
          <EmptyState ready={ready} />
        ) : (
          <Transcript
            events={filteredEvents}
            extensions={searchQuery ? EMPTY_EXTENSIONS : chat.extensions}
            streamingText={searchQuery ? '' : chat.streamingText}
            sending={chat.sending}
            workspaceId={workspaceId}
            hasOlder={!searchQuery && chat.hasOlder}
            onReachedTop={chat.loadOlder}
          />
        )}
      </div>
      {ready && !chat.sending && !chat.isEmpty && (
        <SuggestedActions
          suggestions={deriveSuggestions(chat.events)}
          onPick={(p) => void chat.send(p)}
        />
      )}
      {activeAsk && <AskSheet ask={activeAsk} />}
      <Composer
        ready={ready}
        sending={chat.sending}
        compacting={chat.compacting}
        activeTurnId={chat.activeTurnId}
        workspaceId={workspaceId}
        onSend={(p, atts) => void chat.send(p, atts)}
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
