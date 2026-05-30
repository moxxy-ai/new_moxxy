import { describe, expect, it, vi } from 'vitest';
import {
  asEventId,
  asSessionId,
  asTurnId,
  estimateContextTokens,
  isContextOverflowError,
  runCompactionIfNeeded,
  type CompactorDef,
  type EmittedEvent,
  type EventLogReader,
  type LLMProvider,
  type ModeContext,
  type MoxxyEvent,
  type MoxxyEventOfType,
  type MoxxyEventType,
  type TurnId,
} from './index.js';

const sid = asSessionId('s1');
const tid = asTurnId('t1');

describe('estimateContextTokens', () => {
  it('counts char/4 over events, honoring compaction', () => {
    const log = reader([
      event(0, { type: 'user_prompt', turnId: tid, source: 'user', text: 'x'.repeat(400) }),
      event(1, {
        type: 'compaction',
        turnId: tid,
        source: 'compactor',
        compactor: 'summarize',
        replacedRange: [0, 0],
        summary: 'y'.repeat(40),
        tokensSaved: 90,
      }),
    ]);
    // 400-char user_prompt is covered by the compaction; only the 40-char
    // summary should count.
    expect(estimateContextTokens(log)).toBe(10);
  });
});

describe('runCompactionIfNeeded', () => {
  it('is a no-op when no compactor is active', async () => {
    const ctx = makeCtx({ compactor: null });
    await runCompactionIfNeeded(ctx);
    expect(ctx.emitted).toHaveLength(0);
  });

  it('is a no-op when shouldCompact returns false', async () => {
    const shouldCompact = vi.fn().mockReturnValue(false);
    const compact = vi.fn();
    const ctx = makeCtx({
      compactor: { name: 'fake', shouldCompact, compact },
    });
    await runCompactionIfNeeded(ctx);
    expect(shouldCompact).toHaveBeenCalledOnce();
    expect(compact).not.toHaveBeenCalled();
    expect(ctx.emitted).toHaveLength(0);
  });

  it('passes the real model contextWindow into the budget', async () => {
    let observedWindow = 0;
    const compactor: CompactorDef = {
      name: 'inspect',
      shouldCompact: (_log, budget) => {
        observedWindow = budget.contextWindow;
        return false;
      },
      compact: async () => {
        throw new Error('should not run');
      },
    };
    const ctx = makeCtx({ compactor, model: 'm-200k', contextWindow: 200_000 });
    await runCompactionIfNeeded(ctx);
    expect(observedWindow).toBe(200_000);
  });

  it('emits the compaction event when shouldCompact returns true', async () => {
    const compactor: CompactorDef = {
      name: 'fake',
      shouldCompact: () => true,
      compact: async () => ({
        type: 'compaction',
        sessionId: sid,
        turnId: tid,
        source: 'compactor',
        compactor: 'fake',
        replacedRange: [0, 0],
        summary: 'compressed',
        tokensSaved: 100,
      }),
    };
    const ctx = makeCtx({ compactor });
    await runCompactionIfNeeded(ctx);
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]).toMatchObject({ type: 'compaction', summary: 'compressed' });
  });

  it('skips the emit when compact returns an empty/no-op result', async () => {
    const compactor: CompactorDef = {
      name: 'fake',
      shouldCompact: () => true,
      compact: async () => ({
        type: 'compaction',
        sessionId: sid,
        turnId: tid,
        source: 'compactor',
        compactor: 'fake',
        replacedRange: [0, 0],
        summary: '',
        tokensSaved: 0,
      }),
    };
    const ctx = makeCtx({ compactor });
    await runCompactionIfNeeded(ctx);
    expect(ctx.emitted).toHaveLength(0);
  });

  it('emits a non-fatal error event when compact throws — turn must continue', async () => {
    const compactor: CompactorDef = {
      name: 'broken',
      shouldCompact: () => true,
      compact: async () => {
        throw new Error('boom');
      },
    };
    const ctx = makeCtx({ compactor });
    await runCompactionIfNeeded(ctx);
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]).toMatchObject({ type: 'error', kind: 'retryable' });
  });

  it('force compacts even when shouldCompact returns false', async () => {
    const compact = vi.fn(async () => ({
      type: 'compaction' as const,
      replacedRange: [0, 1] as [number, number],
      summary: 'summary',
      tokensSaved: 500,
    }));
    const compactor: CompactorDef = {
      name: 'gated',
      shouldCompact: () => false, // gate says no…
      compact,
    };
    const ctx = makeCtx({ compactor });
    const did = await runCompactionIfNeeded(ctx, { force: true }); // …but force overrides
    expect(did).toBe(true);
    expect(compact).toHaveBeenCalledOnce();
    expect(ctx.emitted.some((e) => e.type === 'compaction')).toBe(true);
  });
});

describe('isContextOverflowError', () => {
  it('matches common provider context-overflow phrasings', () => {
    for (const msg of [
      'input exceeds context window',
      "This model's maximum context length is 200000 tokens",
      'context_length_exceeded',
      'prompt is too long: 250000 tokens > 200000 maximum',
      'Please reduce the length of the messages',
      'too many input tokens',
    ]) {
      expect(isContextOverflowError(msg)).toBe(true);
    }
  });

  it('does not match unrelated errors', () => {
    for (const msg of ['rate limit exceeded', 'network timeout', '500 internal server error', 'invalid api key']) {
      expect(isContextOverflowError(msg)).toBe(false);
    }
  });
});

interface MakeCtxOpts {
  readonly compactor: CompactorDef | null;
  readonly model?: string;
  readonly contextWindow?: number;
  readonly events?: ReadonlyArray<MoxxyEvent>;
}

function makeCtx(opts: MakeCtxOpts): ModeContext & { emitted: EmittedEvent[] } {
  const events = opts.events ?? [
    event(0, { type: 'user_prompt', turnId: tid, source: 'user', text: 'hi' }),
  ];
  const log = reader(events);
  const provider = {
    name: 'fake',
    models: [
      {
        id: opts.model ?? 'fake-model',
        contextWindow: opts.contextWindow ?? 100_000,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
    stream: async function* () { /* unused */ },
    countTokens: async () => 0,
  } as unknown as LLMProvider;

  const emitted: EmittedEvent[] = [];
  const ctx = {
    sessionId: sid,
    turnId: tid,
    model: opts.model ?? 'fake-model',
    provider,
    tools: { list: () => [], get: () => undefined, execute: async () => undefined },
    skills: { list: () => [], get: () => undefined, byName: () => undefined, filterByTriggers: () => [] },
    log,
    compactor: opts.compactor,
    permissions: { decide: async () => ({ allow: true }) },
    hooks: {} as ModeContext['hooks'],
    pluginHost: { list: () => [], reload: async () => {} },
    signal: new AbortController().signal,
    emit: async (e: EmittedEvent) => {
      emitted.push(e);
      return { ...e, id: asEventId(`e${emitted.length}`), seq: emitted.length, ts: emitted.length, sessionId: sid } as MoxxyEvent;
    },
  } as unknown as ModeContext;

  return Object.assign(ctx, { emitted });
}

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
