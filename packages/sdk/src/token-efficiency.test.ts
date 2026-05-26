import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyLazyTools,
  asEventId,
  asSessionId,
  asToolCallId,
  asTurnId,
  defineTool,
  estimateContextTokens,
  projectMessagesFromLog,
  summarizeSessionTokens,
  type EventLogReader,
  type MoxxyEvent,
  type MoxxyEventOfType,
  type MoxxyEventType,
  type ProviderMessage,
  type TurnId,
} from './index.js';

const sid = asSessionId('s1');
const t1 = asTurnId('t1');
const t2 = asTurnId('t2');

function reader(events: ReadonlyArray<MoxxyEvent>): EventLogReader {
  return {
    length: events.length,
    at: (seq) => events[seq],
    slice: (from = 0, to = events.length) => events.slice(from, to),
    ofType: <T extends MoxxyEventType>(type: T): ReadonlyArray<MoxxyEventOfType<T>> =>
      events.filter((e): e is MoxxyEventOfType<T> => e.type === type),
    byTurn: (turnId: TurnId) => events.filter((e) => e.turnId === turnId),
    toJSON: () => events,
  };
}

function event(seq: number, partial: Omit<MoxxyEvent, 'id' | 'seq' | 'ts' | 'sessionId'>): MoxxyEvent {
  return { id: asEventId(`e${seq}`), seq, ts: seq, sessionId: sid, ...partial } as MoxxyEvent;
}

const bigOutput = 'X'.repeat(5000);

// Log: t1 = old turn (anchor prompt + Read tool call/result + assistant text),
// elision through seq 3, then t2 = recent turn (kept verbatim).
function baseEvents(): MoxxyEvent[] {
  return [
    event(0, { type: 'user_prompt', turnId: t1, source: 'user', text: 'the original task' }),
    event(1, {
      type: 'tool_call_requested',
      turnId: t1,
      source: 'model',
      callId: asToolCallId('c1'),
      name: 'Read',
      input: { file_path: '/a' },
    }),
    event(2, {
      type: 'tool_result',
      turnId: t1,
      source: 'tool',
      callId: asToolCallId('c1'),
      ok: true,
      output: bigOutput,
    }),
    event(3, {
      type: 'assistant_message',
      turnId: t1,
      source: 'model',
      content: 'old detailed answer '.repeat(20),
      stopReason: 'end_turn',
    }),
    event(4, {
      type: 'elision',
      turnId: t2,
      source: 'system',
      elidedThrough: 3,
      stubbedRanges: [[0, 3]],
      elideConversational: true,
      conversationalRecallThreshold: 4,
      maxRecallBytes: 32_768,
      neverElideTools: [],
      tokensSaved: 1200,
    }),
    event(5, { type: 'user_prompt', turnId: t2, source: 'user', text: 'the new task' }),
  ];
}

describe('elision in projectMessagesFromLog', () => {
  it('stubs old tool results but keeps the tool_use pairing intact', () => {
    const msgs = projectMessagesFromLog({ log: reader(baseEvents()) });
    const toolResult = msgs.find((m) => m.role === 'tool_result');
    expect(toolResult).toBeDefined();
    const block = toolResult!.content[0]!;
    expect(block.type === 'tool_result' && block.content).toMatch(/output elided/);
    // The tool_use block must still be present and reference the same callId.
    const assistantToolUse = msgs.find(
      (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
    );
    expect(assistantToolUse).toBeDefined();
    const useBlock = assistantToolUse!.content.find((b) => b.type === 'tool_use')!;
    const resBlock = toolResult!.content[0]!;
    expect(useBlock.type === 'tool_use' && useBlock.id).toBe(
      resBlock.type === 'tool_result' ? resBlock.toolUseId : 'mismatch',
    );
  });

  it('keeps the first user_prompt (task anchor) verbatim even when eliding', () => {
    const msgs = projectMessagesFromLog({ log: reader(baseEvents()) });
    const firstUser = msgs.find((m) => m.role === 'user');
    expect(firstUser!.content[0]).toMatchObject({ type: 'text', text: 'the original task' });
  });

  it('collapses old assistant text to a stub when elideConversational is on', () => {
    const msgs = projectMessagesFromLog({ log: reader(baseEvents()) });
    const stubbed = msgs.find(
      (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && /elided assistant turn/.test(b.text)),
    );
    expect(stubbed).toBeDefined();
  });

  it('keeps recent (post-HWM) content verbatim', () => {
    const msgs = projectMessagesFromLog({ log: reader(baseEvents()) });
    const recent = msgs.find(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === 'the new task'),
    );
    expect(recent).toBeDefined();
  });

  it('marks an elided result as "already recalled" once a recall references it', () => {
    const events = baseEvents();
    events.push(
      event(6, {
        type: 'tool_call_requested',
        turnId: t2,
        source: 'model',
        callId: asToolCallId('r1'),
        name: 'recall',
        input: { callId: 'c1' },
      }),
      event(7, {
        type: 'tool_result',
        turnId: t2,
        source: 'tool',
        callId: asToolCallId('r1'),
        ok: true,
        output: 'recalled full content',
      }),
    );
    const msgs = projectMessagesFromLog({ log: reader(events) });
    const stubs = msgs
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result') as Array<{ type: 'tool_result'; content: string }>;
    expect(stubs.some((b) => /already recalled/.test(b.content))).toBe(true);
    // The recall's own result is pinned (full), never stubbed.
    expect(stubs.some((b) => b.content === 'recalled full content')).toBe(true);
  });
});

describe('estimateContextTokens', () => {
  it('counts an elided tool result as a stub, not its full payload', () => {
    const withElision = estimateContextTokens(reader(baseEvents()));
    const noElision = estimateContextTokens(
      reader(baseEvents().filter((e) => e.type !== 'elision')),
    );
    expect(withElision).toBeLessThan(noElision);
  });

  it('honors never-elide (estimate matches projection: kept full)', () => {
    // Same log, but the Read tool is on the never-elide list → its big output
    // stays full, so the estimate is materially larger.
    const elideable = estimateContextTokens(reader(baseEvents()));
    const neverElide = baseEvents().map((e) =>
      e.type === 'elision' ? { ...e, neverElideTools: ['Read'] } : e,
    );
    expect(estimateContextTokens(reader(neverElide))).toBeGreaterThan(elideable);
  });
});

describe('adaptive conversational elision', () => {
  // anchor + one long old assistant turn, elided, conversational on, threshold 1
  const evs = (extra: MoxxyEvent[] = []): MoxxyEvent[] => [
    event(0, { type: 'user_prompt', turnId: t1, source: 'user', text: 'task' }),
    event(1, {
      type: 'assistant_message',
      turnId: t1,
      source: 'model',
      content: 'old answer '.repeat(40),
      stopReason: 'end_turn',
    }),
    event(2, {
      type: 'elision',
      turnId: t2,
      source: 'system',
      elidedThrough: 1,
      stubbedRanges: [[1, 1]],
      elideConversational: true,
      conversationalRecallThreshold: 1,
      maxRecallBytes: 32_768,
      neverElideTools: [],
      tokensSaved: 100,
    }),
    event(3, { type: 'user_prompt', turnId: t2, source: 'user', text: 'next' }),
    ...extra,
  ];

  const assistantText = (events: MoxxyEvent[]): string =>
    projectMessagesFromLog({ log: reader(events) })
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

  it('stubs old text turns before the recall threshold is hit', () => {
    expect(assistantText(evs())).toMatch(/elided assistant turn/);
  });

  it('reverts old text turns to full once seq-recalls reach the threshold', () => {
    const withRecall = evs([
      event(4, {
        type: 'tool_call_requested',
        turnId: t2,
        source: 'model',
        callId: asToolCallId('rc'),
        name: 'recall',
        input: { seq: 1 },
      }),
    ]);
    const text = assistantText(withRecall);
    expect(text).toMatch(/old answer/);
    expect(text).not.toMatch(/elided assistant turn/);
  });
});

describe('maxRecallBytes cap', () => {
  it('stubs the oldest pinned recalls once the cap is exceeded', () => {
    const events: MoxxyEvent[] = [
      event(0, { type: 'user_prompt', turnId: t1, source: 'user', text: 'task' }),
      event(1, {
        type: 'tool_call_requested',
        turnId: t1,
        source: 'model',
        callId: asToolCallId('ra'),
        name: 'recall',
        input: { callId: 'x' },
      }),
      event(2, {
        type: 'tool_result',
        turnId: t1,
        source: 'tool',
        callId: asToolCallId('ra'),
        ok: true,
        output: 'A'.repeat(300),
      }),
      event(3, {
        type: 'tool_call_requested',
        turnId: t1,
        source: 'model',
        callId: asToolCallId('rb'),
        name: 'recall',
        input: { callId: 'y' },
      }),
      event(4, {
        type: 'tool_result',
        turnId: t1,
        source: 'tool',
        callId: asToolCallId('rb'),
        ok: true,
        output: 'B'.repeat(300),
      }),
      event(5, {
        type: 'elision',
        turnId: t2,
        source: 'system',
        elidedThrough: 4,
        stubbedRanges: [[0, 4]],
        elideConversational: false,
        conversationalRecallThreshold: 4,
        maxRecallBytes: 400, // fits the newest (rb=300) but not both
        neverElideTools: [],
        tokensSaved: 100,
      }),
      event(6, { type: 'user_prompt', turnId: t2, source: 'user', text: 'next' }),
    ];
    const results = projectMessagesFromLog({ log: reader(events) })
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'tool_result'; content: string } => b.type === 'tool_result');
    const rb = results.find((b) => b.content.includes('B'.repeat(300)));
    const ra = results.find((b) => b.content.includes('recall("ra")'));
    expect(rb).toBeDefined(); // newest pinned, full
    expect(ra).toBeDefined(); // oldest over cap, stubbed
  });
});

describe('summarizeSessionTokens', () => {
  it('aggregates usage and computes cache savings', () => {
    const log = reader([
      event(0, {
        type: 'provider_response',
        turnId: t1,
        source: 'system',
        provider: 'anthropic',
        model: 'm',
        inputTokens: 1000,
        outputTokens: 100,
      }),
      event(1, {
        type: 'provider_response',
        turnId: t2,
        source: 'system',
        provider: 'anthropic',
        model: 'm',
        inputTokens: 200,
        cacheReadTokens: 1800,
        cacheCreationTokens: 100,
        outputTokens: 120,
      }),
    ]);
    const s = summarizeSessionTokens(log);
    expect(s.calls).toBe(2);
    expect(s.totalCacheRead).toBe(1800);
    expect(s.totalPrompt).toBe(1000 + 200 + 1800 + 100);
    // billed = 1200*1.0 + 1800*0.1 + 100*1.25 = 1505; uncached = 3100
    expect(Math.round(s.billedInputEq)).toBe(1505);
    expect(s.savedRatio).toBeGreaterThan(0.5);
    expect(s.cacheEffective).toBe(true);
  });

  it('flags cache ineffective when writing cache but never reading it', () => {
    const responses = Array.from({ length: 6 }, (_, i) =>
      event(i, {
        type: 'provider_response',
        turnId: t1,
        source: 'system',
        provider: 'anthropic',
        model: 'm',
        inputTokens: 1000,
        cacheCreationTokens: 1000, // writes happening...
        cacheReadTokens: 0, // ...but no reads → unstable prefix
        outputTokens: 50,
      }),
    );
    expect(summarizeSessionTokens(reader(responses)).cacheEffective).toBe(false);
  });

  it('does not false-alarm when caching is simply off (no writes)', () => {
    const responses = Array.from({ length: 6 }, (_, i) =>
      event(i, {
        type: 'provider_response',
        turnId: t1,
        source: 'system',
        provider: 'anthropic',
        model: 'm',
        inputTokens: 1000,
        outputTokens: 50,
      }),
    );
    expect(summarizeSessionTokens(reader(responses)).cacheEffective).toBe(true);
  });
});

describe('cache prefix stability', () => {
  // The cache only pays off if the projected prefix is byte-identical across
  // the inner iterations of a turn. Guards against anyone introducing per-call
  // nondeterminism (timestamps, reordering) into the projection.
  const turnEvents = (n: number): MoxxyEvent[] => {
    const out: MoxxyEvent[] = [
      event(0, { type: 'user_prompt', turnId: t1, source: 'user', text: 'task' }),
    ];
    let seq = 1;
    for (let i = 0; i < n; i++) {
      out.push(
        event(seq++, {
          type: 'tool_call_requested',
          turnId: t1,
          source: 'model',
          callId: asToolCallId(`c${i}`),
          name: 'Read',
          input: { file_path: `/f${i}` },
        }),
      );
      out.push(
        event(seq++, {
          type: 'tool_result',
          turnId: t1,
          source: 'tool',
          callId: asToolCallId(`c${i}`),
          ok: true,
          output: `result ${i}`,
        }),
      );
    }
    return out;
  };

  it('keeps the earlier-message prefix byte-identical when the next iteration appends', () => {
    const p1 = projectMessagesFromLog({ log: reader(turnEvents(2)) }, { systemPrompt: 'sys' });
    const p2 = projectMessagesFromLog({ log: reader(turnEvents(3)) }, { systemPrompt: 'sys' });
    expect(JSON.stringify(p2.slice(0, p1.length))).toBe(JSON.stringify(p1));
  });
});

describe('applyLazyTools', () => {
  const mk = (name: string) =>
    defineTool({ name, description: `desc ${name}`, inputSchema: z.object({}), handler: () => '' });
  const baseMsgs: ProviderMessage[] = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];

  it('keeps core tools, hides others into a system-prompt index', () => {
    const tools = [mk('Read'), mk('browser_open'), mk('memory_save')];
    const { messages, tools: sent } = applyLazyTools(baseMsgs, tools, reader([]));
    expect(sent.map((t) => t.name)).toEqual(['Read']);
    const sys = messages.find((m) => m.role === 'system')!;
    expect((sys.content[0] as { text: string }).text).toMatch(/Loadable tools/);
    expect((sys.content[0] as { text: string }).text).toMatch(/browser_open/);
  });

  it('includes a tool once it has been load_tool-ed', () => {
    const tools = [mk('Read'), mk('browser_open')];
    const log = reader([
      event(0, {
        type: 'tool_call_requested',
        turnId: t1,
        source: 'model',
        callId: asToolCallId('l1'),
        name: 'load_tool',
        input: { name: 'browser_open' },
      }),
    ]);
    const { tools: sent } = applyLazyTools(baseMsgs, tools, log);
    expect(sent.map((t) => t.name).sort()).toEqual(['Read', 'browser_open']);
  });

  it('is a no-op (stable system prompt) when all tools are core', () => {
    const tools = [mk('Read'), mk('Bash')];
    const { messages, tools: sent } = applyLazyTools(baseMsgs, tools, reader([]));
    expect(sent).toHaveLength(2);
    expect(messages).toBe(baseMsgs); // same reference → byte-stable
  });
});
