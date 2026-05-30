import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  asSkillId,
  definePlugin,
  defineTool,
  skillFrontmatterSchema,
  type Plugin,
  type Skill,
  type SkillScope,
} from '@moxxy/sdk';
import { z } from 'zod';
import { defaultProjectSkillsDir, defaultUserSkillsDir } from './loader.js';
import { draftSkill } from './synthesize-draft.js';
import type { Session } from '../session.js';

export interface SynthesizeOptions {
  readonly userDir?: string;
  readonly projectDir?: string;
  readonly model?: string;
  readonly auditPath?: string;
  /**
   * Directory holding builtin skills (`@moxxy/skills-builtin`). Threaded
   * through so `reload_skills` can rescan the same source set as the boot
   * loader — otherwise reload silently drops the builtins, observed when
   * a session called `reload_skills` and lost every shipped skill.
   */
  readonly builtinDir?: string;
  /** Extra plugin-supplied skill directories. Same boot-vs-reload story. */
  readonly pluginDirs?: ReadonlyArray<string>;
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
  // (missing description, illegal slug, etc.) should fail with a single
  // readable line — the raw zod issue array was dumping ~30 lines of
  // angry red JSON into the chat, which is a worse signal than just
  // saying "the model didn't produce valid frontmatter."
  const parsed = skillFrontmatterSchema.safeParse(draft.frontmatter);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((iss) => iss.path.join('.') || '(root)')
      .join(', ');
    throw new Error(
      `synthesize_skill: the model didn't produce valid skill frontmatter ` +
        `(missing or invalid: ${missing}). This usually means the model returned ` +
        `prose or a code block without proper YAML frontmatter. Try a more specific intent.`,
    );
  }
  const frontmatter = parsed.data as Skill['frontmatter'];

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
          'Uses the active provider to generate the skill body. Returns the path of the created skill. ' +
          'ALWAYS pass scope="user" (the default) unless the user has EXPLICITLY asked to scope ' +
          'the skill to this project — "user" writes to ~/.moxxy/skills/ and the skill is ' +
          'available across every project; "project" writes to <cwd>/.moxxy/skills/ and only ' +
          'applies in this directory. Most skills are general-purpose; pick "project" only when ' +
          'the user said something like "for this repo only" or "project-specific".',
        inputSchema: z.object({
          intent: z.string().min(1).describe('What the user is trying to do. One sentence is enough.'),
          scope: z
            .enum(['user', 'project'])
            .optional()
            .default('user')
            .describe(
              'Where to write the skill. "user" → ~/.moxxy/skills/ (default, recommended). ' +
                '"project" → <cwd>/.moxxy/skills/ — ONLY when the user explicitly asks for a project-scoped skill.',
            ),
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
        name: 'load_skill',
        description:
          'Fetch the full body (instructions) of a pre-authored skill by name. ' +
          'The system prompt lists each skill\'s name, description, and triggers; ' +
          'call this tool to retrieve the actual workflow when the user\'s intent ' +
          'matches one of those skills. Returns the markdown body verbatim plus the ' +
          'frontmatter metadata (allowed-tools, scope, etc.).',
        inputSchema: z.object({
          name: z
            .string()
            .min(1)
            .describe('The exact skill name from the "Available skills" list in the system prompt.'),
        }),
        handler: async ({ name }) => {
          const skill = session.skills.byName(name);
          if (!skill) {
            const known = session.skills
              .list()
              .map((s) => s.frontmatter.name)
              .join(', ');
            throw new Error(
              `load_skill: no skill named "${name}". ` +
                `Known skills: ${known || '(none registered)'}.`,
            );
          }
          // Emit a skill_invoked event so the audit log captures which
          // skills were actually exercised in this turn — useful for
          // routing analytics and for the self-improver agent later.
          await session.log.append({
            type: 'skill_invoked',
            sessionId: session.id,
            turnId: session.startTurn().turnId,
            source: 'model',
            skillId: skill.id,
            name: skill.frontmatter.name,
            reason: 'load_skill_tool',
          });
          return {
            name: skill.frontmatter.name,
            description: skill.frontmatter.description,
            scope: skill.scope,
            allowedTools: skill.frontmatter['allowed-tools'] ?? null,
            body: skill.body,
          };
        },
      }),
      defineTool({
        name: 'reload_skills',
        description:
          'Rescan all skill sources (builtin + plugin + ~/.moxxy/skills + ./.moxxy/skills), ' +
          'registering any new or changed skills.',
        inputSchema: z.object({}),
        // Safe, idempotent, local-only rescan — never prompt. Without this the
        // tool inherits the channel resolver's default, which denies in
        // headless runs (the skill-author flow couldn't activate a new skill).
        permission: { action: 'allow' },
        handler: async () => {
          const { discoverSkills } = await import('./loader.js');
          // Discover first, swap second: never empty the registry while
          // the fs scan is in flight, because concurrent skill lookups
          // would observe an empty registry mid-reload. Pass the SAME
          // source set the boot loader used (builtin + pluginDirs +
          // user + project); a previous version of this handler omitted
          // builtinDir/pluginDirs and reload silently nuked the builtin
          // skill set.
          const discovered = await discoverSkills({
            projectDir: opts.projectDir ?? defaultProjectSkillsDir(session.cwd),
            userDir: opts.userDir ?? defaultUserSkillsDir(),
            ...(opts.builtinDir ? { builtinDir: opts.builtinDir } : {}),
            ...(opts.pluginDirs ? { pluginDirs: opts.pluginDirs } : {}),
          });
          session.skills.replaceAll(discovered);
          return `loaded ${discovered.length} skill${discovered.length === 1 ? '' : 's'}`;
        },
      }),
      defineTool({
        name: 'load_tool',
        description:
          'Load a tool whose full schema was indexed but not sent (see "Loadable tools" ' +
          'in the system prompt). Call this with the tool name; the tool becomes callable ' +
          'on the next turn. Only needed when lazy tool loading is enabled — core tools ' +
          '(Read/Write/Edit/Bash/Grep/Glob) are always available.',
        inputSchema: z.object({
          name: z.string().min(1).describe('Exact tool name from the "Loadable tools" index.'),
        }),
        permission: { action: 'allow' },
        handler: ({ name }) => {
          // The call itself is recorded in the log; `applyLazyTools` reads that
          // to include the tool's schema on subsequent requests. Here we just
          // validate the name and echo the description so the model can proceed.
          const tool = session.tools.get(name);
          if (!tool) {
            const known = session.tools
              .list()
              .map((t) => t.name)
              .join(', ');
            throw new Error(`load_tool: no tool named "${name}". Known tools: ${known}.`);
          }
          return { name: tool.name, description: tool.description, loaded: true };
        },
      }),
    ],
  });
}
