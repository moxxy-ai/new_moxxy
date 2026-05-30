import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { DeskStore } from './desks';

let tmp: string;
let storePath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'desks-'));
  storePath = path.join(tmp, 'desks.json');
});

describe('DeskStore', () => {
  it('returns an empty doc for a missing file', async () => {
    const s = new DeskStore(storePath);
    const list = await s.list();
    expect(list).toEqual([]);
    expect(await s.getActive()).toBeNull();
  });

  it('returns an empty doc for a malformed file', async () => {
    writeFileSync(storePath, '{not json');
    const s = new DeskStore(storePath);
    expect(await s.list()).toEqual([]);
  });

  it('create() persists and auto-activates the first desk', async () => {
    const s = new DeskStore(storePath);
    const desk = await s.create({ name: 'Personal', cwd: '/tmp' });
    expect(desk.id).toBeTruthy();
    expect((await s.list())).toHaveLength(1);
    expect((await s.getActive())?.id).toBe(desk.id);

    // Persistence survives a fresh store instance.
    const fresh = new DeskStore(storePath);
    expect((await fresh.list())[0]!.name).toBe('Personal');
  });

  it('cycles default colors as desks are created', async () => {
    const s = new DeskStore(storePath);
    const a = await s.create({ name: 'A', cwd: '/a' });
    const b = await s.create({ name: 'B', cwd: '/b' });
    expect(a.color).not.toBe(b.color);
  });

  it('setActive() rejects unknown ids', async () => {
    const s = new DeskStore(storePath);
    await expect(s.setActive('nope')).rejects.toThrow(/unknown/);
  });

  it('remove() promotes another desk to active when active is removed', async () => {
    const s = new DeskStore(storePath);
    const a = await s.create({ name: 'A', cwd: '/a' });
    const b = await s.create({ name: 'B', cwd: '/b' });
    await s.setActive(a.id);
    await s.remove(a.id);
    expect((await s.getActive())?.id).toBe(b.id);
  });

  it('atomic write leaves no tmp file behind', async () => {
    const s = new DeskStore(storePath);
    await s.create({ name: 'X', cwd: '/x' });
    expect(existsTmp(storePath)).toBe(false);
  });

  it('write uses pretty JSON', async () => {
    const s = new DeskStore(storePath);
    await s.create({ name: 'X', cwd: '/x' });
    const body = readFileSync(storePath, 'utf8');
    expect(body).toContain('\n');
    expect(body).toContain('"name": "X"');
  });
});

function existsTmp(target: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = require('node:fs');
    return statSync(target + '.tmp').isFile();
  } catch {
    return false;
  }
}
