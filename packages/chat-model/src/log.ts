/**
 * A segmented append log: O(1) append, O(1) last-item mutation (the
 * streaming fast-path), O(pageLen) prepend (scroll-up pagination), and a
 * monotonic `version` counter for cheap snapshot-based change detection
 * (React `useSyncExternalStore` et al.).
 *
 * Items live in fixed-size segments, so an append copies at most one
 * segment-worth of references instead of the whole log — turning a naive
 * `[...blocks, x]`-per-event reducer (O(n²) over a streaming turn) into
 * O(1) amortised. `toArray()` is the only O(n) op; callers materialise a
 * bounded window (`tail(n)`), not the full history, so n stays small.
 *
 * Generic over the element type so it can hold raw events, folded blocks,
 * or anything else a surface needs to stream + paginate.
 */
export class ChunkedBlockLog<T> {
  private readonly segments: T[][];
  private readonly segmentSize: number;
  private count = 0;
  private rev = 0;

  constructor(segmentSize = 128, initial: ReadonlyArray<T> = []) {
    if (segmentSize < 1) throw new RangeError('segmentSize must be >= 1');
    this.segmentSize = segmentSize;
    this.segments = [[]];
    if (initial.length) this.appendMany(initial);
  }

  /** Number of items in the log. */
  get length(): number {
    return this.count;
  }

  /**
   * Bumped on every mutation and never otherwise. A snapshot that
   * captures `version` re-renders only when the log actually changed —
   * the identity foot-gun (`getSnapshot` returning a fresh array each
   * call) is avoided by comparing this number instead.
   */
  get version(): number {
    return this.rev;
  }

  private tailSegment(): T[] {
    return this.segments[this.segments.length - 1]!;
  }

  /** Append one item. O(1) amortised. */
  append(item: T): void {
    let seg = this.tailSegment();
    if (seg.length >= this.segmentSize) {
      seg = [];
      this.segments.push(seg);
    }
    seg.push(item);
    this.count += 1;
    this.rev += 1;
  }

  appendMany(items: ReadonlyArray<T>): void {
    for (const item of items) this.append(item);
  }

  /** The last item, or undefined when empty. */
  last(): T | undefined {
    if (this.count === 0) return undefined;
    const seg = this.tailSegment();
    return seg[seg.length - 1];
  }

  /**
   * Replace the last item via an updater — O(1). The streaming
   * fast-path: fold assistant deltas onto the last block in place
   * without copying the log. No-op when empty.
   */
  mutateLast(update: (item: T) => T): void {
    if (this.count === 0) return;
    const seg = this.tailSegment();
    seg[seg.length - 1] = update(seg[seg.length - 1]!);
    this.rev += 1;
  }

  /** Replace the last item outright. No-op when empty. */
  setLast(item: T): void {
    if (this.count === 0) return;
    const seg = this.tailSegment();
    seg[seg.length - 1] = item;
    this.rev += 1;
  }

  /**
   * Prepend a page of older items (scroll-up pagination) as a new head
   * segment — O(pageLen), independent of how much history is already
   * loaded.
   */
  prepend(items: ReadonlyArray<T>): void {
    if (items.length === 0) return;
    this.segments.unshift(items.slice());
    this.count += items.length;
    this.rev += 1;
  }

  /**
   * Find the last item matching `pred`, scanning from the tail. O(k) in
   * the distance from the end — used to patch a tool-call outcome by
   * callId (results almost always target a recent call). Returns the
   * live reference; mutate it in place then call `touch()` to publish.
   */
  findLast(pred: (item: T) => boolean): T | undefined {
    for (let s = this.segments.length - 1; s >= 0; s -= 1) {
      const seg = this.segments[s]!;
      for (let i = seg.length - 1; i >= 0; i -= 1) {
        if (pred(seg[i]!)) return seg[i];
      }
    }
    return undefined;
  }

  /** Bump `version` without changing contents — publish an in-place edit
   *  made through a reference from `findLast`/`last`. */
  touch(): void {
    this.rev += 1;
  }

  /**
   * Materialise the whole log as a flat array. O(n) — call at most once
   * per change (memoise on `version`); prefer `tail(n)` for a window.
   */
  toArray(): T[] {
    if (this.segments.length === 1) return this.segments[0]!.slice();
    return this.segments.flat();
  }

  /** The last `n` items, oldest first. Cheaper than `toArray()` for a
   *  bounded windowed view. */
  tail(n: number): T[] {
    if (n <= 0) return [];
    if (n >= this.count) return this.toArray();
    const out: T[] = [];
    for (let s = this.segments.length - 1; s >= 0 && out.length < n; s -= 1) {
      const seg = this.segments[s]!;
      for (let i = seg.length - 1; i >= 0 && out.length < n; i -= 1) {
        out.push(seg[i]!);
      }
    }
    out.reverse();
    return out;
  }

  clear(): void {
    this.segments.length = 0;
    this.segments.push([]);
    this.count = 0;
    this.rev += 1;
  }
}
