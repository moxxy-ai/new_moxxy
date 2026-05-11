import { defaultProjectSkillsDir, defaultUserSkillsDir, discoverSkills, silentLogger } from '@moxxy/core';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedArgv } from '../argv.js';

interface AuditEntry {
  slug: string;
  ts: string;
  sessionId: string;
  originatingPrompt: string;
  scope: string;
}

const AUDIT_PATH = (): string => path.join(os.homedir(), '.moxxy', 'skills', '.meta', 'created.jsonl');

export async function runSkillsCommand(argv: ParsedArgv): Promise<number> {
  const sub = argv.positional[0] ?? 'list';
  if (sub === 'list') {
    const skills = await discoverSkills({
      projectDir: defaultProjectSkillsDir(process.cwd()),
      userDir: defaultUserSkillsDir(),
      logger: silentLogger,
    });
    for (const s of skills) {
      process.stdout.write(`${s.frontmatter.name}\t${s.scope}\t${s.frontmatter.description}\n`);
    }
    return 0;
  }
  if (sub === 'new') {
    const name = argv.positional[1];
    if (!name) {
      process.stderr.write('usage: moxxy skills new <name>\n');
      return 2;
    }
    const file = path.join(defaultUserSkillsDir(), `${name}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `---\nname: ${name}\ndescription: TODO\ntriggers: []\nallowed-tools: []\n---\n# ${name}\n\nTODO\n`,
    );
    process.stdout.write(`created ${file}\n`);
    return 0;
  }
  if (sub === 'audit') {
    return await runAudit(argv);
  }
  process.stderr.write(`unknown 'skills' subcommand: ${sub}\n`);
  return 2;
}

async function runAudit(argv: ParsedArgv): Promise<number> {
  const action = argv.positional[1] ?? 'list';
  const entries = await readAuditLog();

  if (action === 'list') {
    if (entries.length === 0) {
      process.stdout.write('(no agent-created skills logged)\n');
      return 0;
    }
    const groups = groupSimilarPrompts(entries);
    for (const group of groups) {
      const header = group.length === 1 ? '' : ` [${group.length} similar]`;
      process.stdout.write(`\n${truncate(group[0]!.originatingPrompt, 80)}${header}\n`);
      for (const e of group) {
        process.stdout.write(`  ${e.scope.padEnd(7)} ${e.slug.padEnd(36)} ${e.ts}\n`);
      }
    }
    return 0;
  }

  if (action === 'revert') {
    const slug = argv.positional[2];
    if (!slug) {
      process.stderr.write('usage: moxxy skills audit revert <slug>\n');
      return 2;
    }
    const match = entries.find((e) => e.slug === slug);
    if (!match) {
      process.stderr.write(`no audit entry for slug: ${slug}\n`);
      return 1;
    }
    const baseDir = match.scope === 'user' ? defaultUserSkillsDir() : defaultProjectSkillsDir(process.cwd());
    const filePath = path.join(baseDir, `${match.slug}.md`);
    let removed = false;
    try {
      await fs.unlink(filePath);
      removed = true;
    } catch {
      // file already gone — still drop the audit entry
    }
    await removeAuditEntry(slug);
    process.stdout.write(
      removed ? `reverted ${slug} (${filePath})\n` : `audit entry removed; skill file was already gone\n`,
    );
    return 0;
  }

  if (action === 'path') {
    process.stdout.write(AUDIT_PATH() + '\n');
    return 0;
  }

  process.stderr.write(`unknown 'skills audit' action: ${action}\n  list | revert <slug> | path\n`);
  return 2;
}

async function readAuditLog(): Promise<AuditEntry[]> {
  try {
    const text = await fs.readFile(AUDIT_PATH(), 'utf8');
    const entries: AuditEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<AuditEntry>;
        if (parsed.slug && parsed.ts && parsed.originatingPrompt && parsed.scope) {
          entries.push({
            slug: parsed.slug,
            ts: parsed.ts,
            sessionId: parsed.sessionId ?? '',
            originatingPrompt: parsed.originatingPrompt,
            scope: parsed.scope,
          });
        }
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function removeAuditEntry(slug: string): Promise<void> {
  try {
    const text = await fs.readFile(AUDIT_PATH(), 'utf8');
    const kept = text
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const e = JSON.parse(line) as { slug?: string };
          return e.slug !== slug;
        } catch {
          return true;
        }
      })
      .join('\n');
    await fs.writeFile(AUDIT_PATH(), kept + (kept ? '\n' : ''));
  } catch {
    // nothing to write back
  }
}

function groupSimilarPrompts(entries: ReadonlyArray<AuditEntry>): AuditEntry[][] {
  const groups: AuditEntry[][] = [];
  for (const entry of entries) {
    const tokens = tokenize(entry.originatingPrompt);
    let placed = false;
    for (const group of groups) {
      const groupTokens = new Set(group.flatMap((e) => tokenize(e.originatingPrompt)));
      const overlap = tokens.filter((t) => groupTokens.has(t)).length;
      if (overlap >= 2) {
        group.push(entry);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([entry]);
  }
  return groups;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
