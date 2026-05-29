import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MoxxyEvent } from '@moxxy/sdk';
import {
  appendEvents,
  loadSegment,
  clearLog,
  listWorkspaces,
  migrate,
} from './chat-log';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'moxxy-chatlog-'));
  process.env['MOXXY_CHATS_DIR'] = dir;
});

afterEach(async () => {
  delete process.env['MOXXY_CHATS_DIR'];
  await rm(dir, { recursive: true, force: true });
});

const ev = (i: number): MoxxyEvent =>
  ({ id: `e${i}`, type: 'user_prompt', text: `m${i}`, seq: i, ts: i, turnId: 'T', sessionId: 'S', source: 'user' }) as unknown as MoxxyEvent;

describe('chat-log NDJSON backend', () => {
  it('appends and loads the tail oldest-first', async () => {
    await appendEvents('w1', [ev(0), ev(1), ev(2)]);
    const seg = await loadSegment('w1', null, 10);
    expect(seg.events.map((e) => (e as { text: string }).text)).toEqual(['m0', 'm1', 'm2']);
    expect(seg.prevCursor).toBeNull();
  });

  it('appends never rewrite old lines (true append-only)', async () => {
    await appendEvents('w1', [ev(0)]);
    await appendEvents('w1', [ev(1)]);
    await appendEvents('w1', [ev(2)]);
    const seg = await loadSegment('w1', null, 10);
    expect(seg.events).toHaveLength(3);
  });

  it('paginates backwards with the cursor', async () => {
    await appendEvents('w1', Array.from({ length: 10 }, (_, i) => ev(i)));
    const tail = await loadSegment('w1', null, 4);
    expect(tail.events.map((e) => (e as { text: string }).text)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(tail.prevCursor).toBe(6);
    const older = await loadSegment('w1', tail.prevCursor, 4);
    expect(older.events.map((e) => (e as { text: string }).text)).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(older.prevCursor).toBe(2);
    const oldest = await loadSegment('w1', older.prevCursor, 4);
    expect(oldest.events.map((e) => (e as { text: string }).text)).toEqual(['m0', 'm1']);
    expect(oldest.prevCursor).toBeNull();
  });

  it('returns empty for an unknown workspace', async () => {
    const seg = await loadSegment('nope', null, 10);
    expect(seg.events).toEqual([]);
    expect(seg.prevCursor).toBeNull();
  });

  it('clearLog truncates', async () => {
    await appendEvents('w1', [ev(0)]);
    await clearLog('w1');
    expect((await loadSegment('w1', null, 10)).events).toEqual([]);
  });

  it('listWorkspaces returns workspaces with a log', async () => {
    await appendEvents('w1', [ev(0)]);
    await appendEvents('w2', [ev(0)]);
    expect((await listWorkspaces()).sort()).toEqual(['w1', 'w2']);
  });

  it('migrate seeds new logs but never clobbers an existing one', async () => {
    await appendEvents('w1', [ev(99)]); // pre-existing
    await migrate([
      { workspaceId: 'w1', events: [ev(0)] }, // should be skipped
      { workspaceId: 'w2', events: [ev(5), ev(6)] }, // should be seeded
    ]);
    expect((await loadSegment('w1', null, 10)).events.map((e) => (e as { text: string }).text)).toEqual(['m99']);
    expect((await loadSegment('w2', null, 10)).events.map((e) => (e as { text: string }).text)).toEqual(['m5', 'm6']);
  });

  it('skips corrupt lines instead of losing the transcript', async () => {
    await appendEvents('w1', [ev(0)]);
    const file = path.join(dir, 'w1.jsonl');
    const body = await readFile(file, 'utf8');
    await import('node:fs/promises').then((fs) => fs.writeFile(file, body + 'not json\n' + JSON.stringify(ev(1)) + '\n'));
    const seg = await loadSegment('w1', null, 10);
    expect(seg.events.map((e) => (e as { text: string }).text)).toEqual(['m0', 'm1']);
  });
});
