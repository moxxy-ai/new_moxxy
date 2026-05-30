import type { EmbeddingProvider, Mutex } from '@moxxy/sdk';
import { TfIdfEmbedder, cosineSimilarity, tokenize } from '../tfidf.js';
import type { EmbeddingIndex } from '../embedding-cache.js';
import type { MemoryEntry } from './types.js';

export interface RankedMemory {
  readonly entry: MemoryEntry;
  readonly score: number;
}

export async function recallVector(
  all: ReadonlyArray<MemoryEntry>,
  query: string,
  limit: number,
  embedder: EmbeddingProvider,
  index: EmbeddingIndex | null,
  mutex: Mutex,
): Promise<ReadonlyArray<RankedMemory>> {
  const corpus = all.map((e) => entryForEmbedding(e));

  // TF-IDF special-cases the persistent cache (vocab is corpus-wide).
  if (embedder instanceof TfIdfEmbedder) {
    embedder.fit([...corpus, query]);
    return rankAllFresh(all, corpus, query, limit, embedder);
  }

  // Neural embedders: consult the persistent cache, only embed misses + query.
  if (index) {
    // The index load->lookup->set->prune->flush cycle mutates the shared
    // on-disk cache, so it must run under the store's write mutex — otherwise
    // two concurrent recalls (or a recall racing forget()'s rebuildIndex)
    // read the same snapshot and clobber each other's writes. Only the cache
    // bookkeeping is serialized; the pure cosine ranking stays outside.
    const { vectors, queryVec } = await mutex.run(async () => {
      await index.load();
      const cached: Array<ReadonlyArray<number> | null> = [];
      const misses: { index: number; text: string }[] = [];
      for (let i = 0; i < all.length; i++) {
        const hit = index.lookup(all[i]!.frontmatter.name, corpus[i]!);
        cached.push(hit);
        if (!hit) misses.push({ index: i, text: corpus[i]! });
      }
      const queryIdx = misses.length;
      const toEmbed = [...misses.map((m) => m.text), query];
      const fresh = await embedder.embed(toEmbed);
      const qVec = fresh[queryIdx]!;
      // Map each missed corpus index to its freshly-embedded vector so the
      // stitch loop below stays O(1) per entry instead of scanning `misses`.
      const freshByEntryIndex = new Map<number, ReadonlyArray<number>>();
      for (const [j, m] of misses.entries()) {
        freshByEntryIndex.set(m.index, fresh[j]!);
      }
      // Stitch results: cached + freshly-embedded
      const vecs: ReadonlyArray<number>[] = [];
      for (let i = 0; i < all.length; i++) {
        vecs.push(cached[i] ?? freshByEntryIndex.get(i)!);
      }
      // Persist fresh vectors
      for (const [j, m] of misses.entries()) {
        index.set(all[m.index]!.frontmatter.name, m.text, fresh[j]!);
      }
      index.prune(all.map((e) => e.frontmatter.name));
      await index.flush();
      return { vectors: vecs, queryVec: qVec };
    });
    return rankCosine(all, vectors, queryVec, limit);
  }

  // No cache configured — embed everything every time.
  return rankAllFresh(all, corpus, query, limit, embedder);
}

// Embed `[...corpus, query]` in one batch, then cosine-rank the corpus against
// the (last) query vector. Shared by the TF-IDF and no-cache branches.
async function rankAllFresh(
  all: ReadonlyArray<MemoryEntry>,
  corpus: ReadonlyArray<string>,
  query: string,
  limit: number,
  embedder: EmbeddingProvider,
): Promise<ReadonlyArray<RankedMemory>> {
  const vectors = await embedder.embed([...corpus, query]);
  const queryVec = vectors[vectors.length - 1]!;
  return rankCosine(all, vectors.slice(0, all.length), queryVec, limit);
}

export function rankByKeywords(
  all: ReadonlyArray<MemoryEntry>,
  query: string,
  limit: number,
): ReadonlyArray<RankedMemory> {
  const tokens = tokenize(query);
  return all
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function rankCosine(
  entries: ReadonlyArray<MemoryEntry>,
  vectors: ReadonlyArray<ReadonlyArray<number>>,
  query: ReadonlyArray<number>,
  limit: number,
): ReadonlyArray<RankedMemory> {
  const ranked: RankedMemory[] = [];
  for (let i = 0; i < entries.length; i++) {
    const score = cosineSimilarity(vectors[i]!, query);
    if (score > 0) ranked.push({ entry: entries[i]!, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

function entryForEmbedding(entry: MemoryEntry): string {
  return [
    entry.frontmatter.name,
    entry.frontmatter.description,
    (entry.frontmatter.tags ?? []).join(' '),
    entry.body,
  ].join('\n');
}

function scoreEntry(entry: MemoryEntry, tokens: ReadonlyArray<string>): number {
  if (tokens.length === 0) return 1;
  const haystack = (
    entry.frontmatter.name +
    ' ' +
    entry.frontmatter.description +
    ' ' +
    (entry.frontmatter.tags ?? []).join(' ') +
    ' ' +
    entry.body
  ).toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    const matches = haystack.split(t).length - 1;
    if (matches > 0) {
      score += matches;
      if (entry.frontmatter.name.toLowerCase().includes(t)) score += 3;
      if (entry.frontmatter.description.toLowerCase().includes(t)) score += 2;
    }
  }
  return score;
}
