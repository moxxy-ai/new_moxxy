import type { EventLogReader, MoxxyEvent } from '@moxxy/sdk';

/**
 * Cheap, no-network estimate of how many tokens the current event log
 * would consume on the next provider request. Used by the TUI's context
 * meter so we can give the user a percentage indicator without calling
 * the provider's `countTokens` on every keystroke.
 *
 * Approximation: chars / 4, summed over the projected message content
 * (user prompts, assistant text, tool calls + results). Compaction
 * events count as their (much shorter) summary.
 *
 * For perfect accuracy use `provider.countTokens(req)`; for a meter
 * that updates every keystroke this is close enough.
 */
export function estimateContextTokens(log: EventLogReader): number {
  let chars = 0;
  const compactedSeqs = new Set<number>();
  for (const e of log.slice()) {
    if (e.type === 'compaction') {
      for (let seq = e.replacedRange[0]; seq <= e.replacedRange[1]; seq++) {
        compactedSeqs.add(seq);
      }
      chars += e.summary.length;
    }
  }
  for (const e of log.slice()) {
    if (compactedSeqs.has(e.seq)) continue;
    chars += eventChars(e);
  }
  return Math.ceil(chars / 4);
}

function eventChars(e: MoxxyEvent): number {
  switch (e.type) {
    case 'user_prompt':
      return e.text.length;
    case 'assistant_message':
      return e.content.length;
    case 'tool_call_requested':
      return e.name.length + safeJsonLen(e.input);
    case 'tool_result':
      if (e.error) return (e.error.message?.length ?? 0) + 12;
      if (typeof e.output === 'string') return e.output.length;
      return safeJsonLen(e.output);
    default:
      return 0;
  }
}

function safeJsonLen(v: unknown): number {
  try {
    return JSON.stringify(v ?? '').length;
  } catch {
    return 0;
  }
}
