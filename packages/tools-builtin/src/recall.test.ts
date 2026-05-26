import { describe, expect, it } from 'vitest';
import {
  asEventId,
  asSessionId,
  asToolCallId,
  asTurnId,
  type EventLogReader,
  type MoxxyEvent,
  type MoxxyEventOfType,
  type MoxxyEventType,
  type ToolContext,
  type TurnId,
} from '@moxxy/sdk';
import { recallTool } from './recall.js';

const sid = asSessionId('s');
const t1 = asTurnId('t1');

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

function ev(seq: number, partial: Omit<MoxxyEvent, 'id' | 'seq' | 'ts' | 'sessionId'>): MoxxyEvent {
  return { id: asEventId(`e${seq}`), seq, ts: seq, sessionId: sid, ...partial } as MoxxyEvent;
}

const ctx = (events: MoxxyEvent[], callId = 'cur'): ToolContext => ({
  sessionId: sid,
  turnId: t1,
  callId: asToolCallId(callId),
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: reader(events),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

describe('recall tool', () => {
  const toolResult = ev(1, {
    type: 'tool_result',
    turnId: t1,
    source: 'tool',
    callId: asToolCallId('c1'),
    ok: true,
    output: 'the full file contents',
  });

  it('returns the full content for a callId', () => {
    const out = recallTool.handler({ callId: 'c1' }, ctx([toolResult])) as string;
    expect(out).toBe('the full file contents');
  });

  it('returns a pointer instead of re-injecting on a repeat recall (idempotency belt)', () => {
    const events = [
      toolResult,
      // a prior recall of the same target, recent
      ev(2, {
        type: 'tool_call_requested',
        turnId: t1,
        source: 'model',
        callId: asToolCallId('prev'),
        name: 'recall',
        input: { callId: 'c1' },
      }),
      // the current recall call (its own event in the log)
      ev(3, {
        type: 'tool_call_requested',
        turnId: t1,
        source: 'model',
        callId: asToolCallId('cur'),
        name: 'recall',
        input: { callId: 'c1' },
      }),
    ];
    const out = recallTool.handler({ callId: 'c1' }, ctx(events, 'cur')) as string;
    expect(out).toMatch(/already recalled/);
    expect(out).not.toContain('the full file contents');
  });

  it('throws for an unknown callId', () => {
    expect(() => recallTool.handler({ callId: 'nope' }, ctx([toolResult]))).toThrow(/no event/);
  });
});
