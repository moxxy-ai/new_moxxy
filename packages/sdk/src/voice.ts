/**
 * Voice / transcription helpers shared across surfaces.
 *
 * The TUI's voice-input infrastructure used to inline the same logic
 * with a `Codex`-specific name baked in. Pulled out here as
 * *agnostic* helpers that take a transcriber name as input, so the
 * desktop, TUI, and any future channel can mirror the same flow:
 *
 *   - Is the session ready to transcribe? Check via the requirements
 *     API for a named transcriber. (`checkTranscriberReady`)
 *   - Activate any registered transcriber lazily. Returns the active
 *     transcriber instance. (`resolveTranscriber`)
 *   - "Just give me whatever works" — try a list of candidates in
 *     order, or fall back to the first registered one. (`pickFirstAvailableTranscriber`)
 */

import type { ClientSession } from './client-session.js';
import type {
  MoxxyRequirement,
  RequirementCheck,
  RequirementIssue,
} from './requirements.js';
import type { Transcriber } from './transcriber.js';

/** Probe whether a *named* transcriber is ready: registered, with any
 *  declared upstream requirements satisfied. The optional `requires`
 *  list lets channels gate on additional provider / auth runtimes
 *  (the Codex transcriber e.g. depends on the `openai-codex` provider
 *  + its OAuth runtime). */
export function checkTranscriberReady(
  session: ClientSession,
  transcriberName: string,
  requires: ReadonlyArray<MoxxyRequirement> = [],
): RequirementCheck {
  const baseline: ReadonlyArray<MoxxyRequirement> = [
    { kind: 'transcriber', name: transcriberName },
    ...requires,
  ];
  const check = session.requirements.check(baseline);
  const activeName = session.transcribers.getActiveName();
  if (!activeName || activeName === transcriberName) return check;

  const conflict: RequirementIssue = {
    requirement: {
      kind: 'transcriber',
      name: transcriberName,
      state: 'active',
      hint: `Switch active transcriber to ${transcriberName}.`,
    },
    code: 'inactive',
    message: `Required active transcriber ${transcriberName}; active is ${activeName}`,
    hint: `Switch active transcriber to ${transcriberName}.`,
  };
  return { ready: false, issues: [conflict, ...check.issues] };
}

/** Activate a transcriber by name, lazily. Returns the active instance
 *  ready to `.transcribe(...)`. Throws if no such transcriber is
 *  registered, or a *different* one is already active. */
export function resolveTranscriber(
  session: ClientSession,
  transcriberName: string,
): Transcriber {
  const activeName = session.transcribers.getActiveName();
  if (activeName && activeName !== transcriberName) {
    throw new Error(
      `Another transcriber is already active: ${activeName}.`,
    );
  }
  if (activeName === transcriberName) return session.transcribers.getActive();
  if (session.transcribers.has(transcriberName)) {
    return session.transcribers.setActive(transcriberName);
  }
  throw new Error(
    `No transcriber registered as ${transcriberName}. Configure one via your moxxy plugins.`,
  );
}

/** "Just pick a transcriber that works."
 *
 *  Tries each name in `candidates` in order — first one that can be
 *  activated wins. Returns null if none can be activated, so callers
 *  can degrade gracefully (hide their mic button, show a "no voice
 *  configured" tip, …) instead of throwing. */
export function pickFirstAvailableTranscriber(
  session: ClientSession,
  candidates: ReadonlyArray<string>,
): Transcriber | null {
  // If something's already active, just hand that back — never fight
  // a user-chosen activation.
  const existing = session.transcribers.tryGetActive();
  if (existing) return existing;
  for (const name of candidates) {
    try {
      return resolveTranscriber(session, name);
    } catch {
      // Wrong-active errors don't apply here (we just returned early),
      // so any throw is "this candidate isn't registered" — keep
      // trying.
    }
  }
  return null;
}
