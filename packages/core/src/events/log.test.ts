import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventLog } from './log.js';
import { asSessionId, asTurnId, asToolCallId } from '@moxxy/sdk';

const sid = asSessionId('s1');
const tid = asTurnId('t1');

describe('EventLog', () => {
  it('appends events and assigns seq + id', async () => {
    const log = new EventLog();
    const a = await log.append({
      type: 'user_prompt',
      sessionId: sid,
      turnId: tid,
      source: 'user',
      text: 'hello',
    });
    const b = await log.append({
      type: 'assistant_message',
      sessionId: sid,
      turnId: tid,
      source: 'model',
      content: 'hi',
      stopReason: 'end_turn',
    });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(a.id).not.toBe(b.id);
    expect(log.length).toBe(2);
  });

  it('filters via ofType', async () => {
    const log = new EventLog();
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'a' });
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'b' });
    await log.append({
      type: 'assistant_message',
      sessionId: sid,
      turnId: tid,
      source: 'model',
      content: '',
      stopReason: 'end_turn',
    });
    const prompts = log.ofType('user_prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[0].text).toBe('a');
  });

  it('filters by turnId', async () => {
    const log = new EventLog();
    const t2 = asTurnId('t2');
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'a' });
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: t2, source: 'user', text: 'b' });
    expect(log.byTurn(tid)).toHaveLength(1);
    expect(log.byTurn(t2)).toHaveLength(1);
  });

  it('notifies subscribers and supports unsubscribe', async () => {
    const log = new EventLog();
    const listener = vi.fn();
    const off = log.subscribe(listener);
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'y' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives listener throws', async () => {
    const log = new EventLog();
    log.subscribe(() => {
      throw new Error('boom');
    });
    await expect(
      log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'x' }),
    ).resolves.toBeDefined();
  });

  it('seeds preserve existing events but new appends start at length()', async () => {
    const seedLog = new EventLog();
    const e1 = await seedLog.append({
      type: 'user_prompt',
      sessionId: sid,
      turnId: tid,
      source: 'user',
      text: 'seed',
    });
    const replay = new EventLog([e1]);
    expect(replay.length).toBe(1);
    const next = await replay.append({
      type: 'assistant_message',
      sessionId: sid,
      turnId: tid,
      source: 'model',
      content: '',
      stopReason: 'end_turn',
    });
    expect(next.seq).toBe(1);
  });

  it('toJSON exposes a copy', async () => {
    const log = new EventLog();
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'a' });
    const json = log.toJSON();
    expect(json).toHaveLength(1);
    // proven via reference inequality after another append
    await log.append({ type: 'user_prompt', sessionId: sid, turnId: tid, source: 'user', text: 'b' });
    expect(json).toHaveLength(1);
    expect(log.length).toBe(2);
  });

  it('ingest preserves the original id/seq/ts and de-dupes by seq', async () => {
    const source = new EventLog();
    const ev = await source.append({
      type: 'user_prompt',
      sessionId: sid,
      turnId: tid,
      source: 'user',
      text: 'mirrored',
    });

    const mirror = new EventLog();
    const seen: number[] = [];
    mirror.subscribe((e) => seen.push(e.seq));
    mirror.ingest(ev);
    // Same identity preserved (not re-materialized).
    expect(mirror.length).toBe(1);
    expect(mirror.at(ev.seq)).toBe(ev);
    expect(mirror.at(ev.seq)?.id).toBe(ev.id);
    // Re-ingesting the same seq is a no-op (idempotent replay/overlap).
    mirror.ingest(ev);
    expect(mirror.length).toBe(1);
    expect(seen).toEqual([ev.seq]);
  });

  // ensure unused import is exercised for typecheck stability
  void z;
  void asToolCallId;
});
