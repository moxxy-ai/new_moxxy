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
}

const blankChat = (): InternalChat => ({
  ...initialChatState,
  lastSeenSeq: 0,
});

class ChatStore {
  private chats = new Map<string, InternalChat>();
  private activeId: string | null = null;
  private listeners = new Set<() => void>();

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

  /** True when there are events past the last time the user opened
   *  this workspace. Always false for the active workspace. */
  hasUnread(workspaceId: string): boolean {
    if (workspaceId === this.activeId) return false;
    const c = this.chats.get(workspaceId);
    if (!c) return false;
    return c.seq > c.lastSeenSeq;
  }

  /** Snapshot of all workspaces that have ever received events. Used
   *  by the sidebar to render unread dots without re-asking the store
   *  for every workspace by id. */
  unreadWorkspaces(): ReadonlyArray<string> {
    const out: string[] = [];
    for (const [id, c] of this.chats) {
      if (id !== this.activeId && c.seq > c.lastSeenSeq) out.push(id);
    }
    return out;
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
    this.emit();
  }

  dispatch(workspaceId: string, action: ChatAction): void {
    const cur = this.ensure(workspaceId);
    const next = chatReducer(cur, action) as InternalChat;
    if (next === cur) return;
    // Carry over the unread cursor; if this workspace IS active,
    // bump it forward so it never trips the unread check.
    next.lastSeenSeq =
      this.activeId === workspaceId ? next.seq : cur.lastSeenSeq;
    this.chats.set(workspaceId, next);
    this.emit();
  }

  /** Drop one workspace's state — used when the user removes a desk. */
  drop(workspaceId: string): void {
    if (this.chats.delete(workspaceId)) this.emit();
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
