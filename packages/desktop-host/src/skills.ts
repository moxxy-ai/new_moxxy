/**
 * Skill file CRUD against the user skills directory
 * (`~/.moxxy/skills/*.md`). The runner picks up changes the next time
 * skills are scanned; for now we don't try to hot-reload.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface SkillFile {
  name: string;
  editable: boolean;
  description?: string;
}

/** Pull the frontmatter `description` (cheap regex — no YAML dep) so the
 *  Skills gallery can show what each skill is for without opening it. */
async function readDescription(file: string): Promise<string | undefined> {
  try {
    const raw = await readFile(file, 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
    if (!fm) return undefined;
    const m = /^description:\s*(.+)$/m.exec(fm[1]!);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

/** Resolved at call time so tests can mock `os.homedir()`. */
function skillsDir(): string {
  return path.join(homedir(), '.moxxy', 'skills');
}

export async function listSkills(): Promise<SkillFile[]> {
  ensureDir();
  try {
    const entries = await readdir(skillsDir());
    const names = entries.filter((name) => name.endsWith('.md')).sort();
    return await Promise.all(
      names.map(async (name) => {
        const description = await readDescription(path.join(skillsDir(), name));
        return { name, editable: true, ...(description ? { description } : {}) };
      }),
    );
  } catch {
    return [];
  }
}

export async function readSkill(name: string): Promise<string> {
  assertSafeName(name);
  return readFile(path.join(skillsDir(), name), 'utf8');
}

export async function writeSkill(name: string, body: string): Promise<void> {
  assertSafeName(name);
  ensureDir();
  await writeFile(path.join(skillsDir(), name), body, 'utf8');
}

export async function deleteSkill(name: string): Promise<void> {
  assertSafeName(name);
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(path.join(skillsDir(), name));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw err;
  }
}

function assertSafeName(name: string): void {
  if (name.includes('/') || name.includes('..') || !name.endsWith('.md')) {
    throw new Error(`invalid skill name: ${name}`);
  }
}

function ensureDir(): void {
  const dir = skillsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
