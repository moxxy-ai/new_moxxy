import { estimateContextTokens } from './compactor-helpers.js';
import { toolResultBytes } from './elision-state.js';
import type { EmittedEvent, MoxxyEvent } from './events.js';
import type { ElisionSettings, ModeContext } from './mode.js';

/**
 * Turn-boundary elision (context-on-demand). Called once per loop iteration by
 * every mode, right next to `runCompactionIfNeeded`. When the recent window
 * exceeds `keepRecentTurns` AND the context is at least `minContextRatioToElide`
 * full, it advances a high-water mark (in whole-turn steps) by appending an
 * `ElisionEvent`. `projectMessagesFromLog` then renders events at or below that
 * mark as compact stubs the model can expand via the `recall` tool.
 *
 * Hard invariants (independent of config): never elide the in-progress turn,
 * never elide the first user_prompt (task anchor — enforced in projection),
 * and degrade to a no-op on any internal error so an elision bug can't kill a
 * turn. The mark only advances on completed-turn boundaries, which keeps the
 * elided prefix byte-stable across a turn's iterations so caching still hits.
 */
export interface ResolvedElisionSettings {
  readonly enabled: boolean;
  readonly keepRecentTurns: number;
  readonly minContextRatioToElide: number;
  readonly elideConversational: boolean;
  readonly conversationalRecallThreshold: number;
  readonly maxRecallBytes: number;
  readonly neverElideTools: ReadonlyArray<string>;
}

const DEFAULTS: ResolvedElisionSettings = {
  enabled: true,
  keepRecentTurns: 4,
  minContextRatioToElide: 0.3,
  // User-selected default: aggressive context-on-demand (collapse old text
  // turns too), but with adaptive auto-disable below.
  elideConversational: true,
  // After this many seq-based recalls, conversational elision switches off for
  // the session (the model is clearly leaning on elided text turns).
  conversationalRecallThreshold: 4,
  maxRecallBytes: 32_768,
  neverElideTools: [],
};

export function resolveElisionSettings(s?: ElisionSettings): ResolvedElisionSettings {
  return {
    enabled: s?.enabled ?? DEFAULTS.enabled,
    // Hard floor: never keep fewer than 2 recent turns verbatim.
    keepRecentTurns: Math.max(2, s?.keepRecentTurns ?? DEFAULTS.keepRecentTurns),
    minContextRatioToElide: s?.minContextRatioToElide ?? DEFAULTS.minContextRatioToElide,
    elideConversational: s?.elideConversational ?? DEFAULTS.elideConversational,
    conversationalRecallThreshold:
      s?.conversationalRecallThreshold ?? DEFAULTS.conversationalRecallThreshold,
    maxRecallBytes: s?.maxRecallBytes ?? DEFAULTS.maxRecallBytes,
    neverElideTools: s?.neverElideTools ?? DEFAULTS.neverElideTools,
  };
}

export async function runElisionIfNeeded(ctx: ModeContext): Promise<void> {
  try {
    const s = resolveElisionSettings(ctx.elision);
    if (!s.enabled) return;

    const descriptor = ctx.provider.models.find((m) => m.id === ctx.model);
    const contextWindow = descriptor?.contextWindow;
    if (!contextWindow || contextWindow <= 0) return;

    // Gate: below this fill the whole history fits comfortably — eliding would
    // only add missed-context risk for no token benefit.
    if (estimateContextTokens(ctx.log) < s.minContextRatioToElide * contextWindow) return;

    const events = ctx.log.slice();
    if (events.length === 0) return;

    const priorHWM = events.reduce(
      (max, e) => (e.type === 'elision' ? Math.max(max, e.elidedThrough) : max),
      -1,
    );

    // Distinct COMPLETED turns in order (exclude the in-progress turn).
    const turnOrder: string[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (e.turnId === ctx.turnId) continue;
      if (!seen.has(e.turnId)) {
        seen.add(e.turnId);
        turnOrder.push(e.turnId);
      }
    }
    if (turnOrder.length <= s.keepRecentTurns) return;

    // Elide every completed turn before the recent window.
    const elideTurns = new Set(turnOrder.slice(0, turnOrder.length - s.keepRecentTurns));
    let to = -1;
    for (const e of events) {
      if (elideTurns.has(e.turnId)) to = Math.max(to, e.seq);
    }
    if (to <= priorHWM) return; // nothing new to elide

    const from = priorHWM + 1;
    const tokensSaved = estimateElisionSavings(events, from, to, s.neverElideTools);

    const emittable: EmittedEvent = {
      type: 'elision',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      elidedThrough: to,
      stubbedRanges: [[from, to]],
      elideConversational: s.elideConversational,
      conversationalRecallThreshold: s.conversationalRecallThreshold,
      maxRecallBytes: s.maxRecallBytes,
      neverElideTools: s.neverElideTools,
      tokensSaved,
    };
    await ctx.emit(emittable);
  } catch {
    // Elision is best-effort; a bug here must never kill the turn.
  }
}

function estimateElisionSavings(
  events: ReadonlyArray<MoxxyEvent>,
  from: number,
  to: number,
  neverElide: ReadonlyArray<string>,
): number {
  const neverSet = new Set(neverElide);
  const toolNameByCall = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'tool_call_requested') toolNameByCall.set(e.callId, e.name);
  }
  let savedChars = 0;
  for (const e of events) {
    if (e.seq < from || e.seq > to) continue;
    if (e.type === 'tool_result' && !e.error) {
      const name = toolNameByCall.get(e.callId);
      if (name && neverSet.has(name)) continue;
      const bytes = toolResultBytes(e.output);
      savedChars += Math.max(0, bytes - 60); // stub is ~60 chars
    }
  }
  return Math.ceil(savedChars / 4);
}
