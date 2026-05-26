import { asTurnId, defineTool, type MoxxyEvent } from '@moxxy/sdk';
import { z } from 'zod';

const MAX_FULL_CHARS = 200_000;
const SUMMARY_CHARS = 1_500;

/**
 * Retrieve content that turn-boundary elision replaced with a stub. The model
 * sees stubs like `[output elided — 4.2 KB · recall("call_123") to view]`; it
 * calls this tool with that callId (or a seq / turnId) to pull the full text
 * back in. Read-only over the event log — must run in-process (it reads
 * `ctx.log`, which an out-of-process isolator wouldn't carry).
 */
export const recallTool = defineTool({
  name: 'recall',
  description:
    'Retrieve earlier content that was elided from context to save tokens. ' +
    'Pass the `callId` shown in an "[output elided — recall(...)]" stub to get a ' +
    'tool result back, or a `seq` / `turnId` to recall an earlier message or whole ' +
    'turn. Set `summarize: true` for a truncated preview instead of the full text. ' +
    'Only call this when you actually need the detail — the recent context is always ' +
    'present verbatim.',
  inputSchema: z.object({
    callId: z.string().optional().describe('The callId from an elided tool-result stub.'),
    seq: z.number().int().nonnegative().optional().describe('Event sequence number to recall.'),
    turnId: z.string().optional().describe('Recall every message from this turn.'),
    summarize: z
      .boolean()
      .optional()
      .describe('Return a truncated preview instead of the full content.'),
  }),
  permission: { action: 'allow' },
  isolation: {
    required: 'inproc',
    capabilities: { net: { mode: 'none' }, timeMs: 5_000 },
  },
  handler: ({ callId, seq, turnId, summarize }, ctx) => {
    const events = ctx.log.slice();

    // Idempotency belt (anti-thrash): if this exact target was recalled in the
    // recent window, its result is already in context — return a pointer rather
    // than re-injecting the bytes and risking a recall loop.
    const RECENT = 40;
    const prior = events.find(
      (e) =>
        e.type === 'tool_call_requested' &&
        e.name === 'recall' &&
        e.callId !== ctx.callId &&
        e.seq >= events.length - RECENT &&
        recallTargetMatches(e.input, { callId, seq, turnId }),
    );
    if (prior) {
      return `[already recalled just above — not re-injecting to save context; scroll up for the full content]`;
    }

    if (callId) {
      const result = events.find(
        (e): e is Extract<MoxxyEvent, { type: 'tool_result' }> =>
          e.type === 'tool_result' && e.callId === callId,
      );
      if (result) return present(renderToolResult(result), summarize);
      const req = events.find(
        (e): e is Extract<MoxxyEvent, { type: 'tool_call_requested' }> =>
          e.type === 'tool_call_requested' && e.callId === callId,
      );
      if (req) return present(`${req.name}(${safeJson(req.input)})`, summarize);
      throw new Error(`recall: no event found for callId "${callId}".`);
    }

    if (seq != null) {
      const e = ctx.log.at(seq);
      if (!e) throw new Error(`recall: no event at seq ${seq}.`);
      const text = renderEvent(e);
      if (!text) throw new Error(`recall: event at seq ${seq} has no recallable content.`);
      return present(text, summarize);
    }

    if (turnId) {
      const turnEvents = ctx.log.byTurn(asTurnId(turnId));
      const body = turnEvents.map(renderEvent).filter(Boolean).join('\n\n');
      if (!body) throw new Error(`recall: no recallable content for turn "${turnId}".`);
      return present(body, summarize);
    }

    throw new Error('recall: provide one of `callId`, `seq`, or `turnId`.');
  },
});

function recallTargetMatches(
  input: unknown,
  target: { callId?: string; seq?: number; turnId?: string },
): boolean {
  if (!input || typeof input !== 'object') return false;
  const i = input as { callId?: unknown; seq?: unknown; turnId?: unknown };
  if (target.callId !== undefined) return i.callId === target.callId;
  if (target.seq !== undefined) return i.seq === target.seq;
  if (target.turnId !== undefined) return i.turnId === target.turnId;
  return false;
}

function renderToolResult(e: Extract<MoxxyEvent, { type: 'tool_result' }>): string {
  if (e.error) return `[error:${e.error.kind}] ${e.error.message}`;
  return typeof e.output === 'string' ? e.output : safeJson(e.output, 2);
}

function renderEvent(e: MoxxyEvent): string {
  switch (e.type) {
    case 'user_prompt':
      return `[user] ${e.text}`;
    case 'assistant_message':
      return `[assistant] ${e.content}`;
    case 'tool_call_requested':
      return `[tool_use ${e.name}] ${safeJson(e.input)}`;
    case 'tool_result':
      return `[tool_result ${e.ok ? 'ok' : 'err'}] ${renderToolResult(e)}`;
    default:
      return '';
  }
}

function present(text: string, summarize?: boolean): string {
  if (summarize && text.length > SUMMARY_CHARS) {
    return `${text.slice(0, SUMMARY_CHARS)}\n… (${text.length - SUMMARY_CHARS} more chars — call recall again without summarize for the full text)`;
  }
  return text.length > MAX_FULL_CHARS ? `${text.slice(0, MAX_FULL_CHARS)}\n… (truncated)` : text;
}

function safeJson(v: unknown, indent?: number): string {
  try {
    return JSON.stringify(v ?? '', null, indent);
  } catch {
    return String(v);
  }
}
