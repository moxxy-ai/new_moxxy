import { describe, expect, it } from 'vitest';
import {
  asEventId,
  asSessionId,
  asTurnId,
  projectMessagesFromLog,
  type EventLogReader,
  type MoxxyEvent,
  type MoxxyEventOfType,
  type MoxxyEventType,
  type TurnId,
} from './index.js';

const sid = asSessionId('s1');
const t1 = asTurnId('t1');
const t2 = asTurnId('t2');

describe('projectMessagesFromLog', () => {
  it('replaces compacted event ranges with the compaction summary', () => {
    const log = reader([
      event(0, { type: 'user_prompt', turnId: t1, source: 'user', text: 'old prompt' }),
      event(1, {
        type: 'assistant_message',
        turnId: t1,
        source: 'model',
        content: 'old answer',
        stopReason: 'end_turn',
      }),
      event(2, {
        type: 'compaction',
        turnId: t1,
        source: 'compactor',
        compactor: 'summarize-old-turns',
        replacedRange: [0, 1],
        summary: 'summary of old prompt and answer',
        tokensSaved: 120,
      }),
      event(3, { type: 'user_prompt', turnId: t2, source: 'user', text: 'current prompt' }),
    ]);

    const messages = projectMessagesFromLog({ log });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('summary of old prompt') }],
    });
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'current prompt' }],
    });
  });
});

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

function event(
  seq: number,
  partial: Omit<MoxxyEvent, 'id' | 'seq' | 'ts' | 'sessionId'>,
): MoxxyEvent {
  return {
    id: asEventId(`e${seq}`),
    seq,
    ts: seq,
    sessionId: sid,
    ...partial,
  } as MoxxyEvent;
}
