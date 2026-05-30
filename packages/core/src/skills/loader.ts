import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { skillFrontmatterSchema, asSkillId, type Skill, type SkillScope } from '@moxxy/sdk';
import { parseSkillFile } from './parse.js';
import type { Logger } from '../logger.js';

export interface SkillLoadOptions {
  readonly projectDir?: string;
  readonly userDir?: string;
  readonly pluginDirs?: ReadonlyArray<string>;
  readonly builtinDir?: string;
  readonly logger?: Logger;
}

export interface DiscoveredSkill extends Skill {
  readonly scope: SkillScope;
}

export async function discoverSkills(opts: SkillLoadOptions = {}): Promise<ReadonlyArray<DiscoveredSkill>> {
  const sources: Array<{ dir: string; scope: SkillScope }> = [];
  if (opts.builtinDir) sources.push({ dir: opts.builtinDir, scope: 'builtin' });
  for (const dir of opts.pluginDirs ?? []) sources.push({ dir, scope: 'plugin' });
  const userDir = opts.userDir ?? defaultUserSkillsDir();
  sources.push({ dir: userDir, scope: 'user' });
  if (opts.projectDir) sources.push({ dir: opts.projectDir, scope: 'project' });

  const seenNames = new Map<string, DiscoveredSkill>();
  for (const source of sources) {
    const skills = await loadDir(source.dir, source.scope, opts.logger);
    for (const skill of skills) seenNames.set(skill.frontmatter.name, skill);
  }
  return [...seenNames.values()];
}

async function loadDir(
  dir: string,
  scope: SkillScope,
  logger?: Logger,
): Promise<ReadonlyArray<DiscoveredSkill>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await loadDir(path.join(dir, entry.name), scope, logger)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = path.join(dir, entry.name);
    const raw = await fs.readFile(full, 'utf8');
    const { frontmatter, body } = parseSkillFile(raw);
    const parsed = skillFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      logger?.warn('skill: invalid frontmatter, skipping', { path: full, issues: parsed.error.issues });
      continue;
    }
    // Auto-derive trigger fallbacks from the skill name when the
    // frontmatter `triggers:` field is missing/empty. Without this,
    // user-authored skills (or model-synthesized ones that skipped the
    // field) have no triggers at all — they're effectively invisible
    // to the trigger-match router and confusing in /skills listings.
    // We split the kebab-case name into words and also keep the full
    // slug as a literal trigger.
    const fm = parsed.data;
    const finalTriggers =
      fm.triggers && fm.triggers.length > 0 ? fm.triggers : deriveTriggers(fm.name);
    out.push({
      id: asSkillId(`${scope}/${fm.name}`),
      path: full,
      scope,
      frontmatter: { ...fm, triggers: finalTriggers },
      body: body.trimEnd(),
    });
  }
  return out;
}

/**
 * Derive trigger-like phrases from a kebab-case skill name. Best-effort
 * fallback for skills whose frontmatter omits the `triggers:` field —
 * gives the router and `/skills` listing *something* to show.
 */
function deriveTriggers(name: string): ReadonlyArray<string> {
  const parts = name.split('-').filter((p) => p.length > 1);
  const out = new Set<string>();
  out.add(name.replace(/-/g, ' '));
  for (const p of parts) out.add(p);
  return [...out];
}

export function defaultUserSkillsDir(): string {
  return path.join(os.homedir(), '.moxxy', 'skills');
}

export function defaultProjectSkillsDir(cwd: string): string {
  return path.join(cwd, '.moxxy', 'skills');
}
