import { describe, expect, it } from 'vitest';
import type { Block } from './types.js';
import { advanceStaticScrollback } from './static-window.js';

function eventBlock(id: string): Block {
  return {
    kind: 'event',
    id,
    event: {
      type: 'user_prompt',
      id,
      sessionId: 'session',
      turnId: 'turn',
      source: 'user',
      text: id,
      ts: 1,
      seq: 1,
    },
  } as unknown as Block;
}

describe('advanceStaticScrollback', () => {
  it('keeps recent settled blocks in the live layout instead of freezing the whole chat', () => {
    const blocks = Array.from({ length: 6 }, (_, index) => eventBlock(`b${index}`));

    const next = advanceStaticScrollback({
      blocks,
      staticBlocks: [],
      generation: 0,
      keepSettledTail: 8,
    });

    expect(next.staticBlocks).toEqual([]);
    expect(next.liveBlocks.map((block) => block.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
    expect(next.generation).toBe(0);
  });

  it('moves only old settled blocks into Static once the live tail is large enough', () => {
    const blocks = Array.from({ length: 12 }, (_, index) => eventBlock(`b${index}`));

    const next = advanceStaticScrollback({
      blocks,
      staticBlocks: [],
      generation: 0,
      keepSettledTail: 4,
    });

    expect(next.staticBlocks.map((block) => block.id)).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
    ]);
    expect(next.liveBlocks.map((block) => block.id)).toEqual(['b8', 'b9', 'b10', 'b11']);
  });
});
