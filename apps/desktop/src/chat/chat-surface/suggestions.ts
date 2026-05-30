import type { MoxxyEvent } from '@moxxy/sdk';

/** Hand-tuned starter prompts shown when the transcript is empty. */
export const COLD_START_SUGGESTIONS: ReadonlyArray<string> = [
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
export function deriveSuggestions(events: ReadonlyArray<MoxxyEvent>): ReadonlyArray<string> {
  if (events.length === 0) return COLD_START_SUGGESTIONS.slice(0, 3);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'assistant_message') {
      const topic = pickTopic(e.content);
      const list = ['Continue', 'Tell me more'];
      if (topic) list.push(`Show an example of ${topic}`);
      else list.push('Show an example');
      return list.slice(0, 3);
    }
    if (e.type === 'tool_call_requested' || e.type === 'tool_result') {
      return ['Explain what just happened', 'Re-run with different inputs', 'Move on'];
    }
    if (e.type === 'error') {
      return ['Try a different approach', 'Show me the logs', 'Skip this for now'];
    }
    if (e.type === 'user_prompt') {
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
