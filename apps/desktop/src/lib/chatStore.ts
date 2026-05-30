/**
 * Renderer-side store of every workspace's chat state. Module-level so a
 * workspace's history survives the user switching away and back.
 *
 * Each workspace owns a {@link ChatRuntime} — an append-only
 * `ChunkedBlockLog` of committed runner events plus the in-flight
 * streaming text. The log is a bounded WINDOW into the durable
 * main-process NDJSON log: on first open we load the most-recent
 * {@link INITIAL_WINDOW} events; scrolling up calls {@link loadOlder} to
 * prepend the preceding page (cursor pagination). New committed events
 * are appended to both the in-memory window and the durable log via the
 * injected {@link ChatPersistence}.
 *
 * A cached {@link ChatSnapshot} keeps `useSyncExternalStore` happy: it is
 * rebuilt only when `rev` changes, and its `events` array reference is
 * preserved across streaming-only ticks so the transcript never re-folds
 * while a chunk is arriving.
 */

import type { MoxxyEvent } from '@moxxy/sdk';
import {
  applyAction,
  createRuntime,
  type ChatAction,
  type ChatRuntime,
  type Extension,
} from './chatModel';
import {
  INITIAL_WINDOW,
  OLDER_PAGE,
  type ChatPersistence,
} from './chatPersistence';

/** One queued turn — the user hit Enter while a previous turn was in
 *  flight. Drained automatically when the active turn completes. */
export interface QueuedTurn {
  readonly id: string;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<{ path: string; name: string }>;
}

/** Immutable view handed to the renderer. `events` is reference-stable
 *  across chunk-only changes so `Transcript`'s fold memo holds. */
export interface ChatSnapshot {
  readonly rev: number;
  readonly eventsVersion: number;
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly extensions: ReadonlyArray<Extension>;
  readonly streamingText: string;
  readonly sending: boolean;
  readonly activeTurnId: string | null;
  readonly error: string | null;
  readonly isEmpty: boolean;
  /** More history exists on disk, fetchable via {@link ChatStore.loadOlder}. */
  readonly hasOlder: boolean;
  /** First on-open disk read is still in flight and nothing has rendered
   *  yet — the transcript shows an initial-loading spinner. */
  readonly loading: boolean;
  /** A manual compaction is in flight — lock the composer so the user can't
   *  send (or queue) while the runner is summarizing the context. */
  readonly compacting: boolean;
}

interface Slot {
  readonly rt: ChatRuntime;
  snap: ChatSnapshot | null;
  model: string | null;
  lastSeenRev: number;
  queue: ReadonlyArray<QueuedTurn>;
  /** Cursor for the next-older page, or null at the start of history. */
  oldestCursor: number | null;
  hasOlder: boolean;
  /** Whether the initial window has been loaded from disk. */
  loaded: boolean;
  /** True while the first on-open disk read is in flight (drives the
   *  transcript's initial-loading spinner). */
  loadingInitial: boolean;
  loadingOlder: boolean;
  /** Token accounting folded from provider_response events (context meter). */
  usage: UsageSnapshot;
  /** Manual compaction in flight (composer lock). */
  compacting: boolean;
}

const EMPTY_QUEUE: ReadonlyArray<QueuedTurn> = Object.freeze([]);
const EMPTY_EVENTS: ReadonlyArray<MoxxyEvent> = Object.freeze([]);
const EMPTY_EXTENSIONS: ReadonlyArray<Extension> = Object.freeze([]);

export const EMPTY_SNAPSHOT: ChatSnapshot = Object.freeze({
  rev: 0,
  eventsVersion: 0,
  events: EMPTY_EVENTS,
  extensions: EMPTY_EXTENSIONS,
  streamingText: '',
  sending: false,
  activeTurnId: null,
  error: null,
  isEmpty: true,
  hasOlder: false,
  loading: false,
  compacting: false,
});

/**
 * Token accounting accumulated from `provider_response` events. Those events
 * carry the provider-reported usage but are NOT rendered or persisted, so they
 * never enter the display log — we fold them into this side-channel snapshot
 * instead (powers the composer's context meter + usage modal). O(1) per call.
 */
export interface UsageSnapshot {
  /** Prompt size of the most recent call (input + cache read + cache write). */
  readonly latestPrompt: number | null;
  /** Per-call prompt sizes in order — feeds the growth sparkline. */
  readonly perCall: ReadonlyArray<number>;
  readonly calls: number;
  readonly totalInput: number;
  readonly totalCacheRead: number;
  readonly totalCacheCreation: number;
  readonly totalOutput: number;
}

export const EMPTY_USAGE: UsageSnapshot = Object.freeze({
  latestPrompt: null,
  perCall: Object.freeze([]),
  calls: 0,
  totalInput: 0,
  totalCacheRead: 0,
  totalCacheCreation: 0,
  totalOutput: 0,
});

/** Compact token count for notices — 1.2k / 3.4M / 812. */
function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

type ProviderResponse = Extract<MoxxyEvent, { type: 'provider_response' }>;

/** Fold one provider_response into the accumulator, or null if it carried no
 *  usage (so callers can skip a re-render). */
function recordUsage(prev: UsageSnapshot, e: ProviderResponse): UsageSnapshot | null {
  const hasUsage =
    e.inputTokens !== undefined ||
    e.outputTokens !== undefined ||
    e.cacheReadTokens !== undefined ||
    e.cacheCreationTokens !== undefined;
  if (!hasUsage) return null;
  const hasPrompt =
    e.inputTokens !== undefined ||
    e.cacheReadTokens !== undefined ||
    e.cacheCreationTokens !== undefined;
  const prompt = (e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0);
  return {
    latestPrompt: hasPrompt ? prompt : prev.latestPrompt,
    perCall: hasPrompt ? [...prev.perCall, prompt] : prev.perCall,
    calls: prev.calls + 1,
    totalInput: prev.totalInput + (e.inputTokens ?? 0),
    totalCacheRead: prev.totalCacheRead + (e.cacheReadTokens ?? 0),
    totalCacheCreation: prev.totalCacheCreation + (e.cacheCreationTokens ?? 0),
    totalOutput: prev.totalOutput + (e.outputTokens ?? 0),
  };
}

class ChatStore {
  private slots = new Map<string, Slot>();
  private activeId: string | null = null;
  private listeners = new Set<() => void>();
  private cachedUnread: ReadonlyArray<string> = [];
  private unreadDirty = true;
  private persistence: ChatPersistence | null = null;
  /** Turn ids whose events must NOT enter the visible transcript — used by
   *  background generations (e.g. AI skill drafting) that run as a real
   *  runner turn but should never show up in the chat. */
  private hiddenTurns = new Set<string>();

  /** Wire the durable backend (called once at boot by ChatStoreBridge). */
  setPersistence(p: ChatPersistence): void {
    this.persistence = p;
  }

  // ---- subscription ------------------------------------------------------

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

  getChat(workspaceId: string): ChatSnapshot {
    const slot = this.slots.get(workspaceId);
    if (!slot) return EMPTY_SNAPSHOT;
    const { rt } = slot;
    if (slot.snap && slot.snap.rev === rt.rev && slot.snap.hasOlder === slot.hasOlder) {
      return slot.snap;
    }
    const eventsChanged =
      !slot.snap || slot.snap.eventsVersion !== rt.log.version;
    const events = eventsChanged ? rt.log.toArray() : slot.snap!.events;
    slot.snap = {
      rev: rt.rev,
      eventsVersion: rt.log.version,
      events,
      extensions: rt.extensions,
      streamingText: rt.streamingText,
      sending: rt.sending,
      activeTurnId: rt.activeTurnId,
      error: rt.error,
      isEmpty: events.length === 0 && rt.extensions.length === 0 && rt.streamingText === '',
      hasOlder: slot.hasOlder,
      // Only "loading" while the first read is in flight AND nothing has
      // rendered yet — a turn that raced ahead of the load shows the
      // transcript, not the spinner.
      loading:
        slot.loadingInitial &&
        events.length === 0 &&
        rt.extensions.length === 0 &&
        rt.streamingText === '',
      compacting: slot.compacting,
    };
    return slot.snap;
  }

  getModel(workspaceId: string): string | null {
    return this.slots.get(workspaceId)?.model ?? null;
  }

  /** Token accounting folded from this workspace's provider responses.
   *  Reference-stable until the next response lands (safe for useSyncExternalStore). */
  getUsage(workspaceId: string): UsageSnapshot {
    return this.slots.get(workspaceId)?.usage ?? EMPTY_USAGE;
  }

  /** Mark a turn's events as background-only — they will be dropped from the
   *  visible transcript (and never persisted). For AI skill drafting etc. */
  hideTurn(turnId: string): void {
    this.hiddenTurns.add(turnId);
  }

  /** Stop hiding a turn (call once the background work has finished). */
  unhideTurn(turnId: string): void {
    this.hiddenTurns.delete(turnId);
  }

  /** Toggle the manual-compaction lock for a workspace (composer disable). */
  setCompacting(workspaceId: string, value: boolean): void {
    const slot = this.ensure(workspaceId);
    if (slot.compacting === value) return;
    slot.compacting = value;
    slot.snap = null;
    this.emit();
  }

  setModel(workspaceId: string, model: string | null): void {
    const slot = this.ensure(workspaceId);
    if (slot.model === model) return;
    slot.model = model;
    this.emit();
  }

  getQueue(workspaceId: string): ReadonlyArray<QueuedTurn> {
    return this.slots.get(workspaceId)?.queue ?? EMPTY_QUEUE;
  }

  enqueue(
    workspaceId: string,
    prompt: string,
    attachments?: ReadonlyArray<{ path: string; name: string }>,
  ): string {
    const slot = this.ensure(workspaceId);
    const id = `q-${slot.rt.rev}-${slot.queue.length}`;
    slot.queue = [
      ...slot.queue,
      attachments && attachments.length > 0 ? { id, prompt, attachments } : { id, prompt },
    ];
    this.emit();
    return id;
  }

  shiftQueue(workspaceId: string): QueuedTurn | null {
    const slot = this.slots.get(workspaceId);
    if (!slot || slot.queue.length === 0) return null;
    const [head, ...rest] = slot.queue;
    slot.queue = rest;
    this.emit();
    return head ?? null;
  }

  dropFromQueue(workspaceId: string, id: string): void {
    const slot = this.slots.get(workspaceId);
    if (!slot) return;
    slot.queue = slot.queue.filter((q) => q.id !== id);
    this.emit();
  }

  hasUnread(workspaceId: string): boolean {
    if (workspaceId === this.activeId) return false;
    const slot = this.slots.get(workspaceId);
    if (!slot) return false;
    return slot.rt.rev > slot.lastSeenRev;
  }

  unreadWorkspaces(): ReadonlyArray<string> {
    if (!this.unreadDirty) return this.cachedUnread;
    const next: string[] = [];
    for (const [id, slot] of this.slots) {
      if (id !== this.activeId && slot.rt.rev > slot.lastSeenRev) next.push(id);
    }
    const prev = this.cachedUnread;
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) {
      this.unreadDirty = false;
      return prev;
    }
    this.cachedUnread = next;
    this.unreadDirty = false;
    return next;
  }

  // ---- async loading (cursor pagination) ---------------------------------

  /**
   * Load the most-recent window of a workspace's history on first open.
   * Idempotent — guarded by `loaded`. Loaded events are prepended (with
   * id-dedup) so any turn that raced ahead of the load stays newest.
   */
  async loadInitial(workspaceId: string): Promise<void> {
    const slot = this.ensure(workspaceId);
    if (slot.loaded || !this.persistence) return;
    slot.loaded = true; // set before await so concurrent calls bail
    slot.loadingInitial = true; // show the spinner while the read is in flight
    slot.snap = null;
    this.emit();
    try {
      const { events, prevCursor } = await this.persistence.loadSegment(
        workspaceId,
        null,
        INITIAL_WINDOW,
      );
      this.prependFresh(slot, events);
      slot.oldestCursor = prevCursor;
      slot.hasOlder = prevCursor !== null;
    } catch {
      slot.loaded = false; // allow a retry on the next open
    } finally {
      slot.loadingInitial = false;
      slot.snap = null;
      this.emit();
    }
  }

  /** Fetch the page preceding the in-memory window (scroll-up). */
  async loadOlder(workspaceId: string): Promise<void> {
    const slot = this.slots.get(workspaceId);
    if (!slot || !slot.hasOlder || slot.loadingOlder || !this.persistence) return;
    slot.loadingOlder = true;
    try {
      const { events, prevCursor } = await this.persistence.loadSegment(
        workspaceId,
        slot.oldestCursor,
        OLDER_PAGE,
      );
      this.prependFresh(slot, events);
      slot.oldestCursor = prevCursor;
      slot.hasOlder = prevCursor !== null;
      slot.snap = null;
      this.emit();
    } catch {
      /* leave hasOlder set so the user can retry by scrolling */
    } finally {
      slot.loadingOlder = false;
    }
  }

  private prependFresh(slot: Slot, events: ReadonlyArray<MoxxyEvent>): void {
    if (events.length === 0) return;
    const have = new Set(slot.rt.log.toArray().map((e) => e.id));
    const fresh = events.filter((e) => !have.has(e.id));
    if (fresh.length > 0) slot.rt.log.prepend(fresh);
  }

  // ---- write side --------------------------------------------------------

  setActive(workspaceId: string | null): void {
    if (this.activeId === workspaceId) return;
    this.activeId = workspaceId;
    if (workspaceId !== null) {
      const slot = this.ensure(workspaceId);
      slot.lastSeenRev = slot.rt.rev;
    }
    this.unreadDirty = true;
    this.emit();
  }

  dispatch(workspaceId: string, action: ChatAction): void {
    const slot = this.ensure(workspaceId);

    // Background turns (e.g. AI skill drafting) never touch the transcript —
    // drop every event/lifecycle tagged with a hidden turn id.
    if (action.type === 'event' && this.hiddenTurns.has(action.event.turnId)) return;
    if (action.type === 'turn_complete' && this.hiddenTurns.has(action.turnId)) {
      this.hiddenTurns.delete(action.turnId);
      return;
    }

    // provider_response carries token usage but is not a rendered/persisted
    // event, so it never lands in the log. Fold its usage into the side-channel
    // accumulator (context meter) and stop — applyAction would no-op for it.
    if (action.type === 'event' && action.event.type === 'provider_response') {
      const next = recordUsage(slot.usage, action.event);
      if (next) {
        slot.usage = next;
        this.emit();
      }
      return;
    }

    // compaction summarizes old turns and shrinks the live context. It's not a
    // rendered event either, so: drop the context meter by the freed tokens,
    // and surface a visible notice in the transcript so the user sees it kick
    // in (whether triggered manually or by the 75% auto-compactor).
    if (action.type === 'event' && action.event.type === 'compaction') {
      const saved = action.event.tokensSaved ?? 0;
      if (saved > 0) {
        if (slot.usage.latestPrompt != null) {
          slot.usage = {
            ...slot.usage,
            latestPrompt: Math.max(0, slot.usage.latestPrompt - saved),
          };
        }
        slot.rt.extensions = [
          ...slot.rt.extensions,
          {
            kind: 'notice',
            id: action.event.id,
            afterCount: slot.rt.log.length,
            tone: 'info',
            text: `Context compacted — freed ~${formatTokensShort(saved)} tokens`,
          },
        ];
        slot.rt.rev += 1;
        slot.snap = null;
        this.unreadDirty = true;
        this.emit();
      }
      return;
    }

    const before = slot.rt.log.length;
    const changed = applyAction(slot.rt, action);
    if (!changed) return;
    // Persist exactly the events this dispatch committed (dispatch only
    // ever appends; prepends come from pagination and are already
    // durable). The tail delta is precisely the new runner events.
    const added = slot.rt.log.length - before;
    if (added > 0 && this.persistence) {
      void this.persistence.append(workspaceId, slot.rt.log.tail(added)).catch(() => {});
    }
    if (this.activeId === workspaceId) slot.lastSeenRev = slot.rt.rev;
    this.unreadDirty = true;
    this.emit();
  }

  /** Drop one workspace's state + its durable log. */
  drop(workspaceId: string): void {
    if (this.slots.delete(workspaceId)) {
      this.unreadDirty = true;
      void this.persistence?.clear(workspaceId).catch(() => {});
      this.emit();
    }
  }

  /** Reset a workspace's transcript without removing the workspace. */
  clear(workspaceId: string): void {
    const slot = this.ensure(workspaceId);
    applyAction(slot.rt, { type: 'clear' });
    slot.oldestCursor = null;
    slot.hasOlder = false;
    slot.usage = EMPTY_USAGE;
    slot.snap = null;
    this.unreadDirty = true;
    void this.persistence?.clear(workspaceId).catch(() => {});
    this.emit();
  }

  // ---- internals ---------------------------------------------------------

  private ensure(workspaceId: string): Slot {
    let slot = this.slots.get(workspaceId);
    if (!slot) {
      slot = {
        rt: createRuntime(),
        snap: null,
        model: null,
        lastSeenRev: 0,
        queue: EMPTY_QUEUE,
        oldestCursor: null,
        hasOlder: false,
        loaded: false,
        loadingInitial: false,
        loadingOlder: false,
        usage: EMPTY_USAGE,
        compacting: false,
      };
      this.slots.set(workspaceId, slot);
    }
    return slot;
  }
}

export const chatStore = new ChatStore();
