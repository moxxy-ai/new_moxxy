import type { MoxxyEvent } from './events.js';

/**
 * Shared elision decision logic — the single source of truth for "is this event
 * stubbed, and to what size", consumed by BOTH `projectMessagesFromLog` (what we
 * send) and `estimateContextTokens` (what we think we send). Keeping them in one
 * leaf module guarantees the estimate matches reality (no overflow from
 * undercounting pinned recalls) and avoids a circular import between the
 * projection and the estimate.
 */

/** Below this size, eliding a turn/result saves nothing — keep it verbatim. */
export const TINY_TURN_CHARS = 200;

/** Bytes of a tool_result payload (for stub labels + the recall cap). */
export function toolResultBytes(output: unknown, errorMessage?: string): number {
  if (errorMessage !== undefined) return errorMessage.length;
  if (typeof output === 'string') return output.length;
  try {
    return JSON.stringify(output ?? '').length;
  } catch {
    return 0;
  }
}

/** Deterministic stub for an elided tool result. Stable bytes → cache-safe. */
export function toolResultStub(callId: string, bytes: number, recalled: boolean): string {
  if (recalled) return `[output elided — already recalled below · call "${callId}"]`;
  const label = bytes >= 1024 ? `${(Math.round(bytes / 102.4) / 10).toFixed(1)} KB` : `${bytes} B`;
  return `[output elided — ${label} · recall("${callId}") to view]`;
}

/** Deterministic stub for an elided conversational (user/assistant) turn. */
export function conversationalStub(role: 'user' | 'assistant', seq: number): string {
  return `[elided ${role} turn · recall({ seq: ${seq} }) to view]`;
}

export interface ElisionState {
  /** Inclusive seq high-water mark; -1 when no elision is active. */
  readonly hwm: number;
  /** Conversational elision after the adaptive auto-disable check. */
  readonly effectiveElideConversational: boolean;
  readonly neverElide: ReadonlySet<string>;
  readonly toolNameByCall: ReadonlyMap<string, string>;
  /** callIds an earlier `recall` referenced (their stub says "already recalled"). */
  readonly recalledCallIds: ReadonlySet<string>;
  readonly recalledSeqs: ReadonlySet<number>;
  /** callIds whose tool_result IS a recall's output — pinned verbatim... */
  readonly recallResultCallIds: ReadonlySet<string>;
  /** ...except these, which exceeded `maxRecallBytes` and get stubbed. */
  readonly unpinnedRecallCallIds: ReadonlySet<string>;
  /** Seq of the first user_prompt (task anchor) — never elided. */
  readonly firstUserPromptSeq: number;
}

const EMPTY_STATE: ElisionState = {
  hwm: -1,
  effectiveElideConversational: false,
  neverElide: new Set(),
  toolNameByCall: new Map(),
  recalledCallIds: new Set(),
  recalledSeqs: new Set(),
  recallResultCallIds: new Set(),
  unpinnedRecallCallIds: new Set(),
  firstUserPromptSeq: -1,
};

/**
 * Derive elision state purely from the log: the active high-water mark + flags
 * (from the latest ElisionEvent), the callId→tool map, recall bookkeeping, the
 * adaptive conversational auto-disable, and which pinned recalls exceed the cap.
 */
export function computeElisionState(events: ReadonlyArray<MoxxyEvent>): ElisionState {
  let hwm = -1;
  let elideConversational = false;
  let conversationalRecallThreshold = Number.POSITIVE_INFINITY;
  let maxRecallBytes = Number.POSITIVE_INFINITY;
  let neverElide: ReadonlyArray<string> = [];
  for (const e of events) {
    if (e.type === 'elision' && e.elidedThrough > hwm) {
      hwm = e.elidedThrough;
      elideConversational = e.elideConversational;
      conversationalRecallThreshold = e.conversationalRecallThreshold;
      maxRecallBytes = e.maxRecallBytes;
      neverElide = e.neverElideTools;
    }
  }
  if (hwm < 0) return EMPTY_STATE;

  const toolNameByCall = new Map<string, string>();
  const recalledCallIds = new Set<string>();
  const recalledSeqs = new Set<number>();
  const recallResultCallIds = new Set<string>();
  let seqRecalls = 0;
  let firstUserPromptSeq = -1;

  for (const e of events) {
    if (e.type === 'tool_call_requested') {
      toolNameByCall.set(e.callId, e.name);
      if (e.name === 'recall') {
        recallResultCallIds.add(e.callId);
        const input = e.input as { callId?: unknown; seq?: unknown } | null | undefined;
        if (input && typeof input === 'object') {
          if (typeof input.callId === 'string') recalledCallIds.add(input.callId);
          if (typeof input.seq === 'number') {
            recalledSeqs.add(input.seq);
            seqRecalls += 1; // seq-recalls = signal that TEXT elision is hurting
          }
        }
      }
    } else if (e.type === 'user_prompt' && firstUserPromptSeq < 0) {
      firstUserPromptSeq = e.seq;
    }
  }

  // Cap pinned recalls: keep the newest recall outputs within maxRecallBytes
  // verbatim, stub the rest. Only matters once a recall result ages below HWM.
  const unpinnedRecallCallIds = new Set<string>();
  const agedRecalls = events
    .filter(
      (e): e is Extract<MoxxyEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && recallResultCallIds.has(e.callId) && e.seq <= hwm,
    )
    .sort((a, b) => b.seq - a.seq); // newest first
  let pinned = 0;
  for (const e of agedRecalls) {
    pinned += toolResultBytes(e.output, e.error?.message);
    if (pinned > maxRecallBytes) unpinnedRecallCallIds.add(e.callId);
  }

  return {
    hwm,
    effectiveElideConversational: elideConversational && seqRecalls < conversationalRecallThreshold,
    neverElide: new Set(neverElide),
    toolNameByCall,
    recalledCallIds,
    recalledSeqs,
    recallResultCallIds,
    unpinnedRecallCallIds,
    firstUserPromptSeq,
  };
}

/** Is this tool_result sent as a stub? (Shared by projection + estimate.) */
export function toolResultStubbed(
  e: Extract<MoxxyEvent, { type: 'tool_result' }>,
  state: ElisionState,
): boolean {
  if (e.seq > state.hwm || e.error) return false;
  const name = state.toolNameByCall.get(e.callId);
  if (name !== undefined && state.neverElide.has(name)) return false;
  if (state.recallResultCallIds.has(e.callId)) {
    // Recall outputs are pinned verbatim unless they blew the cap.
    return state.unpinnedRecallCallIds.has(e.callId);
  }
  if (toolResultBytes(e.output) <= TINY_TURN_CHARS) return false; // tiny: keep full
  return true;
}

/** Is this user/assistant turn collapsed to a conversational stub? */
export function conversationalStubbed(
  e: Extract<MoxxyEvent, { type: 'user_prompt' | 'assistant_message' }>,
  state: ElisionState,
): boolean {
  if (e.seq > state.hwm || !state.effectiveElideConversational) return false;
  if (e.type === 'user_prompt' && e.seq === state.firstUserPromptSeq) return false; // anchor
  const len = e.type === 'user_prompt' ? e.text.length : e.content.length;
  if (len <= TINY_TURN_CHARS) return false;
  return true;
}
