import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '@moxxy/sdk';

const INDEX_FILE = '.embeddings.json';
const INDEX_VERSION = 1;

interface IndexFile {
  readonly version: typeof INDEX_VERSION;
  readonly embedder: string;
  /** Vector dimensionality the cache was built with (undefined = pre-dim format). */
  readonly dim?: number | 'dynamic';
  readonly entries: Record<string, IndexEntry>;
}

interface IndexEntry {
  readonly hash: string;
  readonly vector: ReadonlyArray<number>;
}

/**
 * Persists computed embeddings to `<memoryDir>/.embeddings.json` keyed by
 * content hash. The cache is invalidated when the embedder name OR its
 * dimensionality changes — a name alone is too coarse (e.g. the OpenAI embedder
 * reports a fixed name across models/`dimensions` settings, so a 1536→3072
 * model switch must invalidate on the dim mismatch or recall compares
 * incomparable vectors).
 */
export class EmbeddingIndex {
  private cache: Map<string, IndexEntry> = new Map();
  private dirty = false;

  constructor(
    private readonly dir: string,
    private readonly embedderName: string,
    private readonly dim?: number | 'dynamic',
  ) {}

  static hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 24);
  }

  private get filePath(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as IndexFile;
      if (parsed.version !== INDEX_VERSION) return; // unknown format, ignore
      if (parsed.embedder !== this.embedderName) return; // embedder changed, invalidate
      // Dim mismatch (incl. an old file written before dim was tracked) → the
      // vectors are a different dimensionality; invalidate rather than mix them.
      if (this.dim !== undefined && parsed.dim !== this.dim) return;
      for (const [name, entry] of Object.entries(parsed.entries)) {
        this.cache.set(name, entry);
      }
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  /**
   * For a `(name, body)` pair, return either the cached vector (if the body
   * hash matches) or `null` (miss). Callers re-embed the misses and call
   * `set()` with the fresh vectors.
   */
  lookup(name: string, body: string): ReadonlyArray<number> | null {
    const entry = this.cache.get(name);
    if (!entry) return null;
    if (entry.hash !== EmbeddingIndex.hash(body)) return null;
    return entry.vector;
  }

  set(name: string, body: string, vector: ReadonlyArray<number>): void {
    const hash = EmbeddingIndex.hash(body);
    const existing = this.cache.get(name);
    if (existing && existing.hash === hash) return;
    this.cache.set(name, { hash, vector });
    this.dirty = true;
  }

  /** Drop entries that no longer correspond to existing memories. */
  prune(currentNames: ReadonlyArray<string>): void {
    const wanted = new Set(currentNames);
    for (const name of [...this.cache.keys()]) {
      if (!wanted.has(name)) {
        this.cache.delete(name);
        this.dirty = true;
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const data: IndexFile = {
      version: INDEX_VERSION,
      embedder: this.embedderName,
      ...(this.dim !== undefined ? { dim: this.dim } : {}),
      entries: Object.fromEntries(this.cache),
    };
    await writeFileAtomic(this.filePath, JSON.stringify(data), { mode: 0o600 });
    this.dirty = false;
  }

  get size(): number {
    return this.cache.size;
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
