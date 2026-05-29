/**
 * Renderer-side store of every workspace's chat state. Lives at the
 * module level so a workspace's history survives the user switching
 * away and back. Events stream in on `runner.event` tagged with the
 * workspace id; the store routes each into the matching reducer.
 *
 * Unread tracking: every state-changing dispatch bumps a per-chat
 * `seq` counter. The currently-foregrounded workspace's
 * `lastSeenSeq` is bumped on activation, so anything that arrives
 * for a *different* workspace bumps seq above lastSeenSeq → unread
 * dot shows in the sidebar until the user opens that workspace.
 */

import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatState,
} from './chatReducer';

interface InternalChat extends ChatState {
  lastSeenSeq: number;
  /** Per-workspace model override. The runner exposes runTurn(prompt,
   *  {model}) per-turn; we sticky it client-side so the user can pick
   *  once in the configure modal and have it apply to every send. */
  model: string | null;
}

const blankChat = (): InternalChat => ({
  ...initialChatState,
  lastSeenSeq: 0,
  model: null,
});

/** localStorage namespace prefix. One key per workspace
 *  (`moxxy:chat:<id>`) so a corrupt blob never takes everything down. */
const STORAGE_PREFIX = 'moxxy:chat:';
const STORAGE_VERSION = 1;

/** Hard cap on persisted blocks per workspace. localStorage has a
 *  ~5MB total budget across the whole origin; large tool outputs can
 *  blow that out fast. Cap at the most recent N blocks; older history
 *  drops out of the persisted log but stays in memory while the
 *  session is alive. */
const PERSIST_MAX_BLOCKS = 400;

class ChatStore {
  private chats = new Map<string, InternalChat>();
  private activeId: string | null = null;
  private listeners = new Set<() => void>();
  /** Per-workspace persist debounce so we don't write on every
   *  assistant_chunk (could be 50/sec while streaming). */
  private persistTimers = new Map<string, number>();
  /** Memoised unread-workspace snapshot. useSyncExternalStore calls
   *  getSnapshot every render — returning a fresh array each time is
   *  the textbook "Maximum update depth exceeded" foot-gun. We rebuild
   *  it lazily and only when dispatch/setActive invalidates the
   *  cache. */
  private cachedUnread: ReadonlyArray<string> = [];
  private unreadDirty = true;

  /**
   * Rehydrate every workspace's chat from localStorage. Call once at
   * app boot so the conversations users had before the last restart
   * come back instead of disappearing.
   */
  hydrate(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const id = key.slice(STORAGE_PREFIX.length);
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as
          | (InternalChat & { version?: number })
          | null;
        if (!parsed || parsed.version !== STORAGE_VERSION) continue;
        // Reset any in-flight flags — anything that was streaming
        // when the app closed is definitely not streaming now.
        const restored: InternalChat = {
          ...parsed,
          activeTurnId: null,
          sending: false,
          blocks: parsed.blocks.map((b) =>
            b.kind === 'assistant' && b.streaming ? { ...b, streaming: false } : b,
          ),
        };
        this.chats.set(id, restored);
      } catch {
        /* corrupt blob → drop it */
      }
    }
    this.unreadDirty = true;
    this.emit();
  }

  private persist(workspaceId: string): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const existing = this.persistTimers.get(workspaceId);
    if (existing !== undefined) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      this.persistTimers.delete(workspaceId);
      const chat = this.chats.get(workspaceId);
      if (!chat) {
        localStorage.removeItem(STORAGE_PREFIX + workspaceId);
        return;
      }
      const trimmed: InternalChat & { version: number } = {
        ...chat,
        // Cap the persisted block list; oldest first goes.
        blocks:
          chat.blocks.length > PERSIST_MAX_BLOCKS
            ? chat.blocks.slice(-PERSIST_MAX_BLOCKS)
            : chat.blocks,
        version: STORAGE_VERSION,
      };
      try {
        localStorage.setItem(
          STORAGE_PREFIX + workspaceId,
          JSON.stringify(trimmed),
        );
      } catch {
        /* QuotaExceeded — drop persistence rather than crash */
      }
    }, 250);
    this.persistTimers.set(workspaceId, handle);
  }

  // ---- subscription -------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ---- read side ---------------------------------------------------------

  getActive(): string | null {
    return this.activeId;
  }

  /** Returns the workspace's chat state, creating an empty one if
   *  this is the first reference. */
  getChat(workspaceId: string): ChatState {
    return this.ensure(workspaceId);
  }

  /** Selected model override for this workspace, or null if the
   *  runner's default should be used. */
  getModel(workspaceId: string): string | null {
    return this.chats.get(workspaceId)?.model ?? null;
  }

  setModel(workspaceId: string, model: string | null): void {
    const cur = this.ensure(workspaceId);
    if (cur.model === model) return;
    cur.model = model;
    this.emit();
  }

  /** True when there are events past the last time the user opened
   *  this workspace. Always false for the active workspace. */
  hasUnread(workspaceId: string): boolean {
    if (workspaceId === this.activeId) return false;
    const c = this.chats.get(workspaceId);
    if (!c) return false;
    return c.seq > c.lastSeenSeq;
  }

  /** Snapshot of all workspaces that have ever received events. Used
   *  by the sidebar to render unread dots. The result is memoised so
   *  useSyncExternalStore's same-reference identity check holds across
   *  renders. */
  unreadWorkspaces(): ReadonlyArray<string> {
    if (!this.unreadDirty) return this.cachedUnread;
    const next: string[] = [];
    for (const [id, c] of this.chats) {
      if (id !== this.activeId && c.seq > c.lastSeenSeq) next.push(id);
    }
    // Preserve the previous reference when nothing changed — avoids
    // gratuitous re-renders even when an unrelated chat dispatch
    // marks the cache dirty.
    const prev = this.cachedUnread;
    if (
      prev.length === next.length &&
      prev.every((v, i) => v === next[i])
    ) {
      this.unreadDirty = false;
      return prev;
    }
    this.cachedUnread = next;
    this.unreadDirty = false;
    return next;
  }

  // ---- write side --------------------------------------------------------

  setActive(workspaceId: string | null): void {
    if (this.activeId === workspaceId) return;
    this.activeId = workspaceId;
    if (workspaceId !== null) {
      // Foregrounding clears unread for that workspace.
      const c = this.ensure(workspaceId);
      c.lastSeenSeq = c.seq;
    }
    this.unreadDirty = true;
    this.emit();
  }

  dispatch(workspaceId: string, action: ChatAction): void {
    const cur = this.ensure(workspaceId);
    const next = chatReducer(cur, action) as InternalChat;
    if (next === cur) return;
    next.model = cur.model;
    // Carry over the unread cursor; if this workspace IS active,
    // bump it forward so it never trips the unread check.
    next.lastSeenSeq =
      this.activeId === workspaceId ? next.seq : cur.lastSeenSeq;
    this.chats.set(workspaceId, next);
    this.unreadDirty = true;
    this.persist(workspaceId);
    this.emit();
  }

  /** Drop one workspace's state — used when the user removes a desk
   *  OR clears the conversation from the chat header. */
  drop(workspaceId: string): void {
    if (this.chats.delete(workspaceId)) {
      this.unreadDirty = true;
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(STORAGE_PREFIX + workspaceId);
      }
      this.emit();
    }
  }

  /** Reset one workspace's transcript without removing the workspace
   *  itself. Used by the "Clear conversation" action. */
  clear(workspaceId: string): void {
    const blank = blankChat();
    blank.model = this.chats.get(workspaceId)?.model ?? null;
    this.chats.set(workspaceId, blank);
    this.unreadDirty = true;
    this.persist(workspaceId);
    this.emit();
  }

  // ---- internals ---------------------------------------------------------

  private ensure(workspaceId: string): InternalChat {
    let c = this.chats.get(workspaceId);
    if (!c) {
      c = blankChat();
      this.chats.set(workspaceId, c);
    }
    return c;
  }
}

export const chatStore = new ChatStore();
