import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { EmbeddingProvider } from '@moxxy/sdk';
import { parseMdFile, renderFrontmatter } from './parse.js';
import { TfIdfEmbedder, cosineSimilarity, tokenize } from './tfidf.js';
import { EmbeddingIndex } from './embedding-cache.js';

export const memoryTypeSchema = z.enum(['fact', 'preference', 'project', 'reference']);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const memoryFrontmatterSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be slug-like'),
  type: memoryTypeSchema,
  description: z.string().min(1).max(280),
  tags: z.array(z.string().min(1)).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>;

export interface MemoryEntry {
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
  readonly path: string;
}

export type RecallMode = 'auto' | 'vector' | 'keyword';

export interface MemoryStoreOptions {
  readonly dir?: string;
  /**
   * Optional embedding provider. When supplied, `recall()` uses cosine
   * similarity over dense vectors. When omitted, the built-in TF-IDF
   * embedder is used. Pass `embedder: null` to force keyword-only recall.
   */
  readonly embedder?: EmbeddingProvider | null;
  /**
   * Cache computed embeddings on disk (`<dir>/.embeddings.json`) so unchanged
   * memories aren't re-embedded on every recall. Defaults to true for all
   * embedders EXCEPT TF-IDF (which derives vocab from the whole corpus, so
   * per-entry caching doesn't help).
   */
  readonly persistEmbeddings?: boolean;
}

export function defaultMemoryDir(): string {
  return path.join(os.homedir(), '.moxxy', 'memory');
}

export class MemoryStore {
  readonly dir: string;
  private readonly embedder: EmbeddingProvider | null;
  private readonly index: EmbeddingIndex | null;

  constructor(opts: MemoryStoreOptions = {}) {
    this.dir = opts.dir ?? defaultMemoryDir();
    if (opts.embedder === null) {
      this.embedder = null;
    } else if (opts.embedder !== undefined) {
      this.embedder = opts.embedder;
    } else {
      this.embedder = new TfIdfEmbedder();
    }
    // TF-IDF's vocab depends on the whole corpus, so per-entry caching is
    // useless — recompute every recall. For neural embedders, caching is
    // a big win since each entry's vector is corpus-independent.
    const isTfIdf = this.embedder instanceof TfIdfEmbedder;
    const persist = opts.persistEmbeddings ?? (this.embedder !== null && !isTfIdf);
    this.index = persist && this.embedder ? new EmbeddingIndex(this.dir, this.embedder.name) : null;
  }

  get embedderName(): string {
    return this.embedder?.name ?? 'keyword';
  }

  async list(filterType?: MemoryType): Promise<ReadonlyArray<MemoryEntry>> {
    const entries: MemoryEntry[] = [];
    let names: import('node:fs').Dirent[];
    try {
      names = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    for (const dirent of names) {
      if (!dirent.isFile()) continue;
      if (!dirent.name.endsWith('.md')) continue;
      if (dirent.name === 'MEMORY.md') continue;
      const filePath = path.join(this.dir, dirent.name);
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = parseMdFile(raw);
      const result = memoryFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!result.success) continue;
      if (filterType && result.data.type !== filterType) continue;
      entries.push({
        frontmatter: result.data,
        body: parsed.body.trim(),
        path: filePath,
      });
    }
    return entries;
  }

  async get(name: string): Promise<MemoryEntry | null> {
    const filePath = this.fileFor(name);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = parseMdFile(raw);
      const result = memoryFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!result.success) return null;
      return {
        frontmatter: result.data,
        body: parsed.body.trim(),
        path: filePath,
      };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async save(
    input: Omit<MemoryFrontmatter, 'createdAt' | 'updatedAt'> & { body: string },
  ): Promise<MemoryEntry> {
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = this.fileFor(input.name);
    const existing = await safeRead(filePath);
    const now = new Date().toISOString();
    const createdAt = existing?.frontmatter.createdAt ?? now;
    const frontmatter = memoryFrontmatterSchema.parse({
      name: input.name,
      type: input.type,
      description: input.description,
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      createdAt,
      updatedAt: now,
    });
    const content = `${renderFrontmatter(frontmatter)}\n\n${input.body.trimEnd()}\n`;
    await fs.writeFile(filePath, content, 'utf8');
    await this.rebuildIndex();
    return { frontmatter, body: input.body.trimEnd(), path: filePath };
  }

  async update(
    name: string,
    patch: { body?: string; description?: string; tags?: ReadonlyArray<string> },
  ): Promise<MemoryEntry | null> {
    const existing = await this.get(name);
    if (!existing) return null;
    const mergedTags = patch.tags ?? existing.frontmatter.tags;
    return this.save({
      name: existing.frontmatter.name,
      type: existing.frontmatter.type,
      description: patch.description ?? existing.frontmatter.description,
      ...(mergedTags ? { tags: [...mergedTags] } : {}),
      body: patch.body ?? existing.body,
    });
  }

  async forget(name: string): Promise<boolean> {
    const filePath = this.fileFor(name);
    try {
      await fs.unlink(filePath);
      await this.rebuildIndex();
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  /**
   * Search memories by a free-text query. Uses vector cosine similarity when
   * an EmbeddingProvider is configured (the default is the built-in TF-IDF
   * embedder); falls back to keyword scoring when `mode: 'keyword'` or when
   * no embedder is wired.
   */
  async recall(
    query: string,
    opts: { limit?: number; type?: MemoryType; mode?: RecallMode } = {},
  ): Promise<ReadonlyArray<RankedMemory>> {
    const limit = opts.limit ?? 5;
    const mode = opts.mode ?? 'auto';
    const all = await this.list(opts.type);
    if (all.length === 0) return [];

    const useVector = mode === 'vector' || (mode === 'auto' && this.embedder !== null);
    if (useVector && this.embedder) {
      return this.recallVector(all, query, limit);
    }
    return rankByKeywords(all, query, limit);
  }

  private async recallVector(
    all: ReadonlyArray<MemoryEntry>,
    query: string,
    limit: number,
  ): Promise<ReadonlyArray<RankedMemory>> {
    if (!this.embedder) return [];
    const corpus = all.map((e) => entryForEmbedding(e));

    // TF-IDF special-cases the persistent cache (vocab is corpus-wide).
    if (this.embedder instanceof TfIdfEmbedder) {
      this.embedder.fit([...corpus, query]);
      const vectors = await this.embedder.embed([...corpus, query]);
      const queryVec = vectors[vectors.length - 1]!;
      return rankCosine(all, vectors.slice(0, all.length), queryVec, limit);
    }

    // Neural embedders: consult the persistent cache, only embed misses + query.
    if (this.index) {
      await this.index.load();
      const cached: Array<ReadonlyArray<number> | null> = [];
      const misses: { index: number; text: string }[] = [];
      for (let i = 0; i < all.length; i++) {
        const hit = this.index.lookup(all[i]!.frontmatter.name, corpus[i]!);
        cached.push(hit);
        if (!hit) misses.push({ index: i, text: corpus[i]! });
      }
      const queryIdx = misses.length;
      const toEmbed = [...misses.map((m) => m.text), query];
      const fresh = await this.embedder.embed(toEmbed);
      const queryVec = fresh[queryIdx]!;
      // Stitch results: cached + freshly-embedded
      const vectors: ReadonlyArray<number>[] = [];
      for (let i = 0; i < all.length; i++) {
        vectors.push(cached[i] ?? fresh[misses.findIndex((m) => m.index === i)]!);
      }
      // Persist fresh vectors
      for (const m of misses) {
        this.index.set(all[m.index]!.frontmatter.name, m.text, fresh[misses.indexOf(m)]!);
      }
      this.index.prune(all.map((e) => e.frontmatter.name));
      await this.index.flush();
      return rankCosine(all, vectors, queryVec, limit);
    }

    // No cache configured — embed everything every time.
    const vectors = await this.embedder.embed([...corpus, query]);
    const queryVec = vectors[vectors.length - 1]!;
    return rankCosine(all, vectors.slice(0, all.length), queryVec, limit);
  }

  private fileFor(name: string): string {
    return path.join(this.dir, `${name}.md`);
  }

  private async rebuildIndex(): Promise<void> {
    const entries = await this.list();
    const lines = ['# Memory index', ''];
    const byType = new Map<MemoryType, MemoryEntry[]>();
    for (const e of entries) {
      const list = byType.get(e.frontmatter.type) ?? [];
      list.push(e);
      byType.set(e.frontmatter.type, list);
    }
    for (const t of ['fact', 'preference', 'project', 'reference'] as const) {
      const items = byType.get(t);
      if (!items || items.length === 0) continue;
      lines.push(`## ${t}`);
      for (const item of items) {
        lines.push(`- [${item.frontmatter.name}](${path.basename(item.path)}) — ${item.frontmatter.description}`);
      }
      lines.push('');
    }
    await fs.writeFile(path.join(this.dir, 'MEMORY.md'), lines.join('\n'), 'utf8');
  }
}

export interface RankedMemory {
  readonly entry: MemoryEntry;
  readonly score: number;
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

function rankByKeywords(
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

async function safeRead(filePath: string): Promise<{ frontmatter: MemoryFrontmatter; body: string } | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseMdFile(raw);
    const result = memoryFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!result.success) return null;
    return { frontmatter: result.data, body: parsed.body };
  } catch {
    return null;
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
