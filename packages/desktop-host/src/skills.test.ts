/**
 * Skill CRUD test — drives the file ops against a tempdir HOME and
 * asserts the validator rejects unsafe names.
 *
 * We override `process.env.HOME` so `os.homedir()` returns the tempdir
 * (works on macOS + Linux). Mocking the ESM-imported `homedir` named
 * binding doesn't survive `vi.resetModules` reliably; the env-var
 * route is the documented, in-process API for `homedir()` and is
 * exactly what we want under test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, readSkill, writeSkill } from './skills';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'moxxy-skills-')));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('skills', () => {
  it('lists nothing in a fresh home', async () => {
    expect(await listSkills()).toEqual([]);
  });

  it('round-trips a skill', async () => {
    await writeSkill('hello.md', '# hi');
    const list = await listSkills();
    expect(list.map((s) => s.name)).toEqual(['hello.md']);
    expect(await readSkill('hello.md')).toBe('# hi');
  });

  it('rejects path traversal', async () => {
    await expect(writeSkill('../evil.md', 'x')).rejects.toThrow(/invalid/);
    await expect(readSkill('a/b.md')).rejects.toThrow(/invalid/);
    await expect(writeSkill('plain.txt', 'x')).rejects.toThrow(/invalid/);
  });

  it('only lists .md files, sorted', async () => {
    await writeSkill('zebra.md', 'z');
    await writeSkill('apple.md', 'a');
    const list = await listSkills();
    expect(list.map((s) => s.name)).toEqual(['apple.md', 'zebra.md']);
  });
});
