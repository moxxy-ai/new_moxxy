/**
 * Desktop chat model. Replaces the old flat-Block reducer with the
 * shared @moxxy/chat-model fold: the store keeps an append-only log of
 * the *committed* runner events, the in-flight assistant text lives in a
 * separate `streamingText` string (so a streaming chunk is O(1) and
 * never re-folds the log), and the render tree is derived by
 * `pairToolEvents` over a window of events — exactly how the TUI's
 * ChatView separates settled events from the live preview.
 *
 * Desktop-only timeline cards that are NOT runner events (slash-command
 * result cards, local notices) live in a small `extensions` array,
 * anchored by the event count at insertion so they render in order.
 * They are ephemeral — not part of the persisted event log.
 *
 * Kept React-free so the runtime can be driven directly by tests.
 */

import type { MoxxyEvent } from '@moxxy/sdk';
import {
  ChunkedBlockLog,
  newBlockId,
  pairToolEvents,
  type Block as FoldedBlock,
  type ToolCallBlockData,
} from '@moxxy/chat-model';

export type { FoldedBlock };

export interface ChatAttachment {
  readonly path: string;
  readonly name: string;
}

/** Slash-command result card or a locally-generated notice — desktop UI
 *  that has no corresponding runner event. `afterCount` anchors it after
 *  the Nth committed event so it renders in chronological order. */
export type Extension =
  | {
      readonly kind: 'action_result';
      readonly id: string;
      readonly afterCount: number;
      readonly commandName: string;
      readonly argsLine: string;
      readonly tone: 'info' | 'error' | 'notice';
      readonly text: string;
    }
  | {
      readonly kind: 'notice';
      readonly id: string;
      readonly afterCount: number;
      readonly tone: 'info' | 'error';
      readonly text: string;
    };

/** One node of the rendered transcript: a folded chat-model block, a desktop
 *  extension card, or a run of ≥2 consecutive standalone tool calls collapsed
 *  into one group (see {@link groupToolNodes}). */
export type RenderNode =
  | { readonly kind: 'block'; readonly block: FoldedBlock }
  | { readonly kind: 'ext'; readonly ext: Extension }
  | { readonly kind: 'tool-group'; readonly id: string; readonly tools: ReadonlyArray<ToolCallBlockData> };

/**
 * Collapse runs of ≥2 consecutive top-level `tool-call` nodes into a single
 * `tool-group` node so a burst of back-to-back Writes/fetches reads as one
 * collapsible "Tools (N)" block instead of N stacked rows. A lone tool keeps
 * its own top-level block; anything non-tool (assistant text, a skill scope,
 * an extension) breaks the run.
 */
export function groupToolNodes(nodes: ReadonlyArray<RenderNode>): RenderNode[] {
  const out: RenderNode[] = [];
  let run: ToolCallBlockData[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      out.push({ kind: 'tool-group', id: `toolgroup:${run[0]!.id}`, tools: run });
    } else if (run.length === 1) {
      out.push({ kind: 'block', block: run[0]! });
    }
    run = [];
  };
  for (const n of nodes) {
    if (n.kind === 'block' && n.block.kind === 'tool-call') {
      run.push(n.block);
    } else {
      flush();
      out.push(n);
    }
  }
  flush();
  return out;
}

export type ChatAction =
  | { type: 'event'; event: MoxxyEvent }
  | { type: 'send_started'; turnId: string }
  | { type: 'send_failed'; message: string }
  | { type: 'turn_complete'; turnId: string; error: string | null }
  | {
      type: 'action_result';
      commandName: string;
      argsLine: string;
      tone: 'info' | 'error' | 'notice';
      text: string;
    }
  | { type: 'dismiss_block'; blockId: string }
  | { type: 'clear' };

/**
 * Runner event types the chat surface renders. Everything else
 * (provider_request/response, mode_iteration, compaction, elision,
 * plugin_registered, …) is bookkeeping noise that would otherwise fold
 * into stray EventBlocks. `assistant_chunk` is handled separately (it
 * drives the live preview), so it is deliberately absent here.
 */
const RENDERED_EVENT_TYPES: ReadonlySet<MoxxyEvent['type']> = new Set([
  'user_prompt',
  'assistant_message',
  'tool_call_requested',
  'tool_result',
  'tool_call_approved',
  'tool_call_denied',
  'skill_invoked',
  'error',
  'abort',
]);

const SUBAGENT_PLUGIN_ID = '@moxxy/subagents';

/** Mutable per-workspace chat state. The log is append-only; the rest is
 *  small scalar/array state. `rev` bumps on every change for snapshot
 *  identity; `log.version` changes only when a committed event lands. */
export interface ChatRuntime {
  readonly log: ChunkedBlockLog<MoxxyEvent>;
  extensions: Extension[];
  streamingText: string;
  activeTurnId: string | null;
  sending: boolean;
  error: string | null;
  rev: number;
}

export function createRuntime(initialEvents: ReadonlyArray<MoxxyEvent> = []): ChatRuntime {
  return {
    log: new ChunkedBlockLog<MoxxyEvent>(128, initialEvents),
    extensions: [],
    streamingText: '',
    activeTurnId: null,
    sending: false,
    error: null,
    rev: 0,
  };
}

/** Should this runner event be committed to the rendered log? */
export function isRenderedEvent(event: MoxxyEvent): boolean {
  if (event.type === 'plugin_event') return event.pluginId === SUBAGENT_PLUGIN_ID;
  return RENDERED_EVENT_TYPES.has(event.type);
}

/** Apply a runner event. Returns true if anything changed. */
export function applyEvent(rt: ChatRuntime, event: MoxxyEvent): boolean {
  if (event.type === 'assistant_chunk') {
    // O(1): accumulate into the live preview; never touches the log, so a
    // 200-chunk reply over a 2000-event log does zero array work.
    rt.streamingText += event.delta;
    rt.rev += 1;
    return true;
  }
  if (event.type === 'assistant_message') {
    rt.log.append(event);
    rt.streamingText = '';
    rt.rev += 1;
    return true;
  }
  if (!isRenderedEvent(event)) return false;
  rt.log.append(event);
  rt.rev += 1;
  return true;
}

/** Apply a desktop UI action. Returns true if anything changed. */
export function applyAction(rt: ChatRuntime, action: ChatAction): boolean {
  switch (action.type) {
    case 'event':
      return applyEvent(rt, action.event);
    case 'send_started':
      rt.activeTurnId = action.turnId;
      rt.sending = true;
      rt.error = null;
      rt.rev += 1;
      return true;
    case 'send_failed':
      rt.sending = false;
      rt.error = action.message;
      rt.rev += 1;
      return true;
    case 'turn_complete': {
      // Commit any streamed text the provider never sealed with an
      // assistant_message, so the reply is never lost on turn end.
      if (rt.streamingText.trim()) {
        rt.log.append(synthAssistantMessage(rt.streamingText, action.turnId));
      }
      rt.streamingText = '';
      rt.sending = false;
      rt.activeTurnId = null;
      if (action.error) {
        rt.extensions = [
          ...rt.extensions,
          {
            kind: 'notice',
            id: newBlockId(),
            afterCount: rt.log.length,
            tone: 'error',
            text: action.error,
          },
        ];
      }
      rt.rev += 1;
      return true;
    }
    case 'action_result':
      rt.extensions = [
        ...rt.extensions,
        {
          kind: 'action_result',
          id: newBlockId(),
          afterCount: rt.log.length,
          commandName: action.commandName,
          argsLine: action.argsLine,
          tone: action.tone,
          text: action.text,
        },
      ];
      rt.rev += 1;
      return true;
    case 'dismiss_block': {
      const next = rt.extensions.filter((x) => x.id !== action.blockId);
      if (next.length === rt.extensions.length) return false;
      rt.extensions = next;
      rt.rev += 1;
      return true;
    }
    case 'clear':
      rt.log.clear();
      rt.extensions = [];
      rt.streamingText = '';
      rt.activeTurnId = null;
      rt.sending = false;
      rt.error = null;
      rt.rev += 1;
      return true;
    default:
      return false;
  }
}

/**
 * Derive the ordered render tree from a window of committed events plus
 * the extension cards. Events are folded by `pairToolEvents`; extensions
 * split the fold at their anchor so they slot in chronologically.
 * Because an extension's `afterCount` is the log length when it was
 * added, a tool call and its result (same turn) are never split across a
 * boundary.
 */
export function buildRenderNodes(
  events: ReadonlyArray<MoxxyEvent>,
  extensions: ReadonlyArray<Extension>,
): RenderNode[] {
  const out: RenderNode[] = [];
  const sorted = [...extensions].sort((a, b) => a.afterCount - b.afterCount);
  let cursor = 0;
  const fold = (slice: ReadonlyArray<MoxxyEvent>): void => {
    if (slice.length === 0) return;
    for (const block of pairToolEvents(slice)) out.push({ kind: 'block', block });
  };
  for (const ext of sorted) {
    const at = Math.min(Math.max(ext.afterCount, 0), events.length);
    if (at > cursor) {
      fold(events.slice(cursor, at));
      cursor = at;
    }
    out.push({ kind: 'ext', ext });
  }
  fold(events.slice(cursor));
  return out;
}

/** Synthesize an assistant_message event from streamed text (the
 *  turn-end fallback). Only the fields the fold + renderer read are
 *  meaningful; the rest satisfy the branded EventBase shape. */
function synthAssistantMessage(text: string, turnId: string): MoxxyEvent {
  return {
    type: 'assistant_message',
    content: text,
    stopReason: 'end_turn',
    id: newBlockId(),
    seq: -1,
    ts: Date.now(),
    sessionId: '',
    turnId,
    source: 'model',
  } as unknown as MoxxyEvent;
}
