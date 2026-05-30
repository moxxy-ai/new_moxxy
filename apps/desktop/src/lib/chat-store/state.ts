/**
 * Per-workspace chat state: the public {@link ChatSnapshot} view handed to
 * the renderer, the internal {@link Slot} the store mutates, their empty
 * defaults, and the pure snapshot builder.
 *
 * Each workspace owns a {@link ChatRuntime} — an append-only `ChunkedBlockLog`
 * of committed runner events plus the in-flight streaming text — wrapped in a
 * {@link Slot} that also tracks the queued turns, pagination cursor, loading
 * flags, token usage, and the compaction lock.
 *
 * A cached {@link ChatSnapshot} keeps `useSyncExternalStore` happy: it is
 * rebuilt only when `rev` changes, and its `events` array reference is
 * preserved across streaming-only ticks so the transcript never re-folds
 * while a chunk is arriving.
 */

import type { MoxxyEvent } from '@moxxy/sdk';
import { createRuntime, type ChatRuntime, type Extension } from '../chatModel';
import { EMPTY_USAGE, type UsageSnapshot } from './usage';

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

export interface Slot {
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

export const EMPTY_QUEUE: ReadonlyArray<QueuedTurn> = Object.freeze([]);
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

/** A fresh, empty {@link Slot} for a newly-seen workspace. */
export function createSlot(): Slot {
  return {
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
}

/**
 * Rebuild (and cache) a slot's renderer snapshot. Reuses the cached snapshot
 * when neither `rev` nor `hasOlder` changed, and preserves the `events` array
 * reference across streaming-only ticks (when `log.version` is unchanged) so
 * the transcript never re-folds while a chunk is arriving.
 */
export function buildSnapshot(slot: Slot): ChatSnapshot {
  const { rt } = slot;
  if (slot.snap && slot.snap.rev === rt.rev && slot.snap.hasOlder === slot.hasOlder) {
    return slot.snap;
  }
  const eventsChanged = !slot.snap || slot.snap.eventsVersion !== rt.log.version;
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
