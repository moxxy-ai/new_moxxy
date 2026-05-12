import { describe, expect, it, vi } from 'vitest';
import { CachedEmbeddingProvider, type EmbeddingProvider } from '@moxxy/sdk';

const makeUpstream = (responses: ReadonlyArray<ReadonlyArray<number>>) => {
  let cursor = 0;
  const embed = vi.fn(async (texts: ReadonlyArray<string>) => {
    const out = responses.slice(cursor, cursor + texts.length);
    cursor += texts.length;
    return out;
  });
  const upstream: EmbeddingProvider = { name: 'stub', dim: 3, embed };
  return { upstream, embed };
};

describe('CachedEmbeddingProvider', () => {
  it('forwards on first call, serves repeats from cache', async () => {
    const { upstream, embed } = makeUpstream([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const cached = new CachedEmbeddingProvider(upstream);
    expect(await cached.embed(['a', 'b'])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    // Second call with identical texts should not hit upstream
    expect(await cached.embed(['a', 'b'])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('only fetches the missing entries on partial overlap', async () => {
    const { upstream, embed } = makeUpstream([[1], [2], [3]]);
    const cached = new CachedEmbeddingProvider(upstream);
    await cached.embed(['a', 'b']);
    const result = await cached.embed(['b', 'c']);
    expect(result).toEqual([[2], [3]]);
    expect(embed).toHaveBeenCalledTimes(2);
    // The second call should have included only 'c'
    expect(embed.mock.calls[1]?.[0]).toEqual(['c']);
  });

  it('serialize/hydrate round-trip preserves cached entries', async () => {
    const a = makeUpstream([[5, 6]]);
    const cached = new CachedEmbeddingProvider(a.upstream);
    await cached.embed(['x']);
    const snapshot = cached.serialize();

    const b = makeUpstream([]);
    const cached2 = new CachedEmbeddingProvider(b.upstream);
    cached2.hydrate(snapshot);
    expect(await cached2.embed(['x'])).toEqual([[5, 6]]);
    expect(b.embed).not.toHaveBeenCalled();
  });

  it('name is upstream + "+cache"', () => {
    const { upstream } = makeUpstream([]);
    expect(new CachedEmbeddingProvider(upstream).name).toBe('stub+cache');
  });

  it('clear() empties the cache', async () => {
    const { upstream, embed } = makeUpstream([[1], [1]]);
    const cached = new CachedEmbeddingProvider(upstream);
    await cached.embed(['x']);
    cached.clear();
    expect(cached.size).toBe(0);
    await cached.embed(['x']);
    expect(embed).toHaveBeenCalledTimes(2);
  });
});
