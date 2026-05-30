import { describe, it, expect } from 'vitest';
import { ChunkedBlockLog } from './log.js';
import { newBlockId } from './id.js';

describe('ChunkedBlockLog', () => {
  it('appends across segment boundaries and materialises in order', () => {
    const log = new ChunkedBlockLog<number>(4);
    for (let i = 0; i < 10; i += 1) log.append(i);
    expect(log.length).toBe(10);
    expect(log.toArray()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(log.last()).toBe(9);
  });

  it('bumps version on every mutation and only on mutation', () => {
    const log = new ChunkedBlockLog<string>(2);
    const v0 = log.version;
    log.append('a');
    const v1 = log.version;
    expect(v1).toBeGreaterThan(v0);
    // a pure read does not bump
    log.toArray();
    log.last();
    log.tail(1);
    expect(log.version).toBe(v1);
    log.mutateLast((s) => s + '!');
    expect(log.version).toBeGreaterThan(v1);
    expect(log.last()).toBe('a!');
  });

  it('mutateLast is the O(1) streaming path (no array copy needed)', () => {
    const log = new ChunkedBlockLog<{ text: string }>(8);
    log.append({ text: '' });
    for (const delta of ['hel', 'lo ', 'wor', 'ld']) {
      log.mutateLast((b) => ({ text: b.text + delta }));
    }
    expect(log.last()).toEqual({ text: 'hello world' });
    expect(log.length).toBe(1);
  });

  it('prepend adds older pages ahead of everything (pagination)', () => {
    const log = new ChunkedBlockLog<number>(4, [5, 6, 7]);
    log.prepend([1, 2, 3, 4]);
    expect(log.toArray()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(log.length).toBe(7);
    log.append(8);
    expect(log.toArray()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('tail(n) returns a bounded window without materialising everything', () => {
    const log = new ChunkedBlockLog<number>(3);
    for (let i = 0; i < 20; i += 1) log.append(i);
    expect(log.tail(5)).toEqual([15, 16, 17, 18, 19]);
    expect(log.tail(0)).toEqual([]);
    expect(log.tail(100)).toEqual(log.toArray());
  });

  it('findLast + touch patches a recent item in place', () => {
    const log = new ChunkedBlockLog<{ id: string; done: boolean }>(4);
    for (const id of ['a', 'b', 'c']) log.append({ id, done: false });
    const before = log.version;
    const hit = log.findLast((x) => x.id === 'b');
    expect(hit).toBeDefined();
    hit!.done = true;
    log.touch();
    expect(log.version).toBeGreaterThan(before);
    expect(log.toArray().find((x) => x.id === 'b')!.done).toBe(true);
  });

  it('mutateLast / setLast / last are no-ops on an empty log', () => {
    const log = new ChunkedBlockLog<number>(4);
    expect(log.last()).toBeUndefined();
    log.mutateLast((n) => n + 1);
    log.setLast(42);
    expect(log.length).toBe(0);
  });

  it('clear empties the log and bumps version', () => {
    const log = new ChunkedBlockLog<number>(4, [1, 2, 3]);
    const v = log.version;
    log.clear();
    expect(log.length).toBe(0);
    expect(log.toArray()).toEqual([]);
    expect(log.version).toBeGreaterThan(v);
    log.append(9);
    expect(log.toArray()).toEqual([9]);
  });

  it('rejects an invalid segment size', () => {
    expect(() => new ChunkedBlockLog<number>(0)).toThrow();
  });
});

describe('newBlockId', () => {
  it('produces unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) ids.add(newBlockId());
    expect(ids.size).toBe(1000);
  });
});
