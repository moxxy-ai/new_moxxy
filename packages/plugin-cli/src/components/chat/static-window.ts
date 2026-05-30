import { isSettled, type Block } from '@moxxy/chat-model';

export const DEFAULT_STATIC_SETTLED_TAIL = 8;

export interface StaticScrollbackState {
  readonly blocks: ReadonlyArray<Block>;
  readonly staticBlocks: ReadonlyArray<Block>;
  readonly generation: number;
  readonly keepSettledTail?: number;
}

export interface StaticScrollbackNext {
  readonly staticBlocks: Block[];
  readonly liveBlocks: ReadonlyArray<Block>;
  readonly generation: number;
}

export function advanceStaticScrollback(state: StaticScrollbackState): StaticScrollbackNext {
  const keepSettledTail = state.keepSettledTail ?? DEFAULT_STATIC_SETTLED_TAIL;
  const settledCount = leadingSettledCount(state.blocks);
  const targetStaticCount = Math.max(0, settledCount - keepSettledTail);

  if (
    state.blocks.length < state.staticBlocks.length ||
    !hasSamePrefix(state.blocks, state.staticBlocks)
  ) {
    const staticBlocks = state.blocks.slice(0, targetStaticCount);
    return {
      staticBlocks,
      liveBlocks: state.blocks.slice(staticBlocks.length),
      generation: state.generation + 1,
    };
  }

  const staticBlocks =
    targetStaticCount > state.staticBlocks.length
      ? state.blocks.slice(0, targetStaticCount)
      : [...state.staticBlocks];

  return {
    staticBlocks,
    liveBlocks: state.blocks.slice(staticBlocks.length),
    generation: state.generation,
  };
}

function leadingSettledCount(blocks: ReadonlyArray<Block>): number {
  let count = 0;
  for (const block of blocks) {
    if (!isSettled(block)) break;
    count += 1;
  }
  return count;
}

function hasSamePrefix(blocks: ReadonlyArray<Block>, prefix: ReadonlyArray<Block>): boolean {
  if (prefix.length > blocks.length) return false;
  return prefix.every((block, index) => blocks[index]?.id === block.id);
}
