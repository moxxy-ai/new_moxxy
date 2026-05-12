import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  asSkillId,
  definePlugin,
  defineTool,
  skillFrontmatterSchema,
  type LLMProvider,
  type Plugin,
  type Skill,
  type SkillScope,
} from '@moxxy/sdk';
import { z } from 'zod';
import { defaultProjectSkillsDir, defaultUserSkillsDir } from './loader.js';
import { parseSkillFile } from './parse.js';
import type { Session } from '../session.js';

export interface SynthesizeOptions {
  readonly userDir?: string;
  readonly projectDir?: string;
  readonly model?: string;
  readonly auditPath?: string;
}

export interface SynthesizedSkill {
  readonly skill: Skill;
  readonly path: string;
  readonly scope: SkillScope;
}

export async function synthesizeSkill(
  session: Session,
  intent: string,
  scope: 'user' | 'project',
  opts: SynthesizeOptions = {},
): Promise<SynthesizedSkill> {
  const provider = session.providers.getActive();
  const model = opts.model ?? provider.models[0]?.id ?? 'claude-sonnet-4-6';
  const draft = await draftSkill(provider, model, intent, session.signal);

  const baseDir =
    scope === 'project'
      ? opts.projectDir ?? defaultProjectSkillsDir(session.cwd)
      : opts.userDir ?? defaultUserSkillsDir();
  await fs.mkdir(baseDir, { recursive: true });

  // Validate the LLM-drafted frontmatter against the published schema BEFORE
  // we write it to disk or register it. A model that returns sloppy YAML
  // (missing description, illegal slug, etc.) should fail loudly here, not
  // produce a malformed skill the loader silently ignores later.
  const frontmatter = skillFrontmatterSchema.parse(draft.frontmatter) as Skill['frontmatter'];

  const finalPath = await uniqueFilename(baseDir, slugify(frontmatter.name));
  await fs.writeFile(finalPath, draft.raw, 'utf8');

  // Derive the skill id from the on-disk filename, not from the LLM-supplied
  // frontmatter name — otherwise synthesizing the same name twice collides
  // even when uniqueFilename has just bumped the filename to `<slug>-2.md`.
  const basename = path.basename(finalPath, '.md');
  const skill: Skill = {
    id: asSkillId(`${scope}/${basename}`),
    path: finalPath,
    scope,
    frontmatter,
    body: draft.body.trimEnd(),
  };
  session.skills.register(skill);

  await session.log.append({
    type: 'skill_created',
    sessionId: session.id,
    turnId: session.startTurn().turnId,
    source: 'system',
    skillId: skill.id,
    name: skill.frontmatter.name,
    path: finalPath,
    scope,
    originatingPrompt: intent,
  });

  const auditPath = opts.auditPath ?? path.join(defaultUserSkillsDir(), '.meta', 'created.jsonl');
  await appendAudit(auditPath, {
    slug: path.basename(finalPath, '.md'),
    ts: new Date().toISOString(),
    sessionId: String(session.id),
    originatingPrompt: intent,
    scope,
  });

  return { skill, path: finalPath, scope };
}

interface DraftedSkill {
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

async function draftSkill(
  provider: LLMProvider,
  model: string,
  intent: string,
  signal: AbortSignal,
): Promise<DraftedSkill> {
  const system = `You are a skill-author. Output ONLY a Markdown file with YAML frontmatter. No prose outside the Markdown. Frontmatter MUST include:
- name (kebab-case slug, <=60 chars, lowercase letters/numbers/hyphens only, starting with a letter)
- description (1 sentence, <=120 chars)
- triggers (array of 2-5 short phrases the user might say)
- allowed-tools (array of tool names, e.g. ["Read", "Edit", "Bash"])

The body is the instructions for future invocations. Keep it under 30 lines. Numbered steps preferred.`;

  let accumulated = '';
  for await (const event of provider.stream({
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: `User intent: ${intent}` }] }],
    maxTokens: 2000,
    signal,
  })) {
    if (event.type === 'text_delta') accumulated += event.delta;
    if (event.type === 'error') {
      throw new Error(`synthesizeSkill: provider error: ${event.message}`);
    }
  }

  const raw = extractMarkdownBlock(accumulated);
  const { frontmatter, body } = parseSkillFile(raw);
  return { raw, frontmatter: frontmatter as Record<string, unknown>, body };
}

function extractMarkdownBlock(s: string): string {
  const fence = /```(?:markdown|md)?\n([\s\S]*?)```/.exec(s);
  return fence ? fence[1]! : s;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function uniqueFilename(dir: string, base: string): Promise<string> {
  let candidate = path.join(dir, `${base}.md`);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base}-${n}.md`);
    n += 1;
  }
  return candidate;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function appendAudit(filePath: string, entry: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

export function buildSynthesizeSkillPlugin(
  session: Session,
  opts: SynthesizeOptions = {},
): Plugin {
  return definePlugin({
    name: '@moxxy/synthesize-skill',
    version: '0.0.0',
    tools: [
      defineTool({
        name: 'synthesize_skill',
        description:
          'Draft and persist a new Markdown skill for the given user intent. ' +
          'Uses the active provider to generate the skill body. Returns the path of the created skill.',
        inputSchema: z.object({
          intent: z.string().min(1).describe('What the user is trying to do. One sentence is enough.'),
          scope: z.enum(['user', 'project']).optional().default('user'),
        }),
        permission: { action: 'prompt' },
        handler: async ({ intent, scope }) => {
          const result = await synthesizeSkill(session, intent, scope, opts);
          return {
            path: result.path,
            scope: result.scope,
            name: result.skill.frontmatter.name,
          };
        },
      }),
      defineTool({
        name: 'reload_skills',
        description: 'Rescan ~/.moxxy/skills and ./.moxxy/skills, registering any new or changed skills.',
        inputSchema: z.object({}),
        handler: async () => {
          const { discoverSkills } = await import('./loader.js');
          // Discover first, swap second: never empty the registry while
          // the fs scan is in flight, because concurrent skill lookups
          // would observe an empty registry mid-reload.
          const discovered = await discoverSkills({
            projectDir: defaultProjectSkillsDir(session.cwd),
            userDir: opts.userDir ?? defaultUserSkillsDir(),
          });
          session.skills.replaceAll(discovered);
          return `loaded ${discovered.length} skill${discovered.length === 1 ? '' : 's'}`;
        },
      }),
    ],
  });
}
