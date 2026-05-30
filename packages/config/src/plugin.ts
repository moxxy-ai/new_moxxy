import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z, defineTool, definePlugin, moxxyPath, writeFileAtomic, type Plugin } from '@moxxy/sdk';
import { loadConfig } from './loader.js';
import { moxxyConfigSchema, type MoxxyConfig } from './schema.js';

/**
 * Optional callback that the CLI (or any session host) can provide to apply
 * config changes to a live session without a restart. The applier receives the
 * full validated config snapshot AFTER the write; it should diff against its
 * own cached state and update the parts it can apply safely.
 *
 * Return a list of changed paths that were reflected at runtime, plus any
 * that need a session restart to take effect.
 */
export interface ConfigApplyResult {
  readonly applied: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
}
export type ConfigApplier = (snapshot: MoxxyConfig) => Promise<ConfigApplyResult>;

const scopeSchema = z.enum(['user', 'project']);
type Scope = z.infer<typeof scopeSchema>;
// Default scope when the model omits it. Project-local is the safer
// default for read tools — touching the user-global file is usually an
// explicit operator action, not an inferred one.
const scopeSchemaOptional = scopeSchema.optional().default('project');

const USER_YAML = (): string => moxxyPath('config.yaml');

// Cap upward filesystem traversal when searching for a project config.
const MAX_CONFIG_SEARCH_DEPTH = 12;

async function findScopePath(scope: Scope, cwd: string): Promise<string | null> {
  if (scope === 'user') {
    const yaml = USER_YAML();
    try {
      await fs.access(yaml);
      return yaml;
    } catch {
      return null;
    }
  }
  // Project scope: walk upward looking for moxxy.config.yaml first, .yml second.
  let cursor = path.resolve(cwd);
  for (let i = 0; i < MAX_CONFIG_SEARCH_DEPTH; i++) {
    for (const name of ['moxxy.config.yaml', 'moxxy.config.yml']) {
      const candidate = path.join(cursor, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function scopeDefaultPath(scope: Scope, cwd: string): string {
  return scope === 'user' ? USER_YAML() : path.join(cwd, 'moxxy.config.yaml');
}

async function readDoc(filePath: string): Promise<{ doc: import('yaml').Document.Parsed; text: string }> {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  const yamlMod = (await import('yaml')) as typeof import('yaml');
  const doc = yamlMod.parseDocument(text);
  return { doc, text };
}

function parseDotPath(p: string): Array<string | number> {
  if (!p) return [];
  return p.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function parseValue(raw: string): unknown {
  // Try JSON first (allows arrays, numbers, booleans, strings, objects).
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function buildConfigPlugin(
  opts: { cwd: string; applier?: ConfigApplier } = { cwd: process.cwd() },
): Plugin {
  const cwd = opts.cwd;
  const applier = opts.applier;

  return definePlugin({
    name: '@moxxy/plugin-config',
    version: '0.0.0',
    tools: [
      defineTool({
        name: 'config_path',
        description:
          'Return the resolved file path for the moxxy config at a given scope ' +
          '(defaults to "project" — the moxxy.config.yaml in the current dir). ' +
          'Returns null if no file exists yet.',
        inputSchema: z.object({ scope: scopeSchemaOptional }),
        handler: async ({ scope }) => {
          const found = await findScopePath(scope, cwd);
          return { scope, path: found, defaultPath: scopeDefaultPath(scope, cwd) };
        },
      }),
      defineTool({
        name: 'config_show',
        description:
          'Return the raw text of the moxxy config at the given scope (defaults to "project"). ' +
          'Useful when the agent needs to inspect or edit it.',
        inputSchema: z.object({ scope: scopeSchemaOptional }),
        handler: async ({ scope }) => {
          const found = await findScopePath(scope, cwd);
          if (!found) return { scope, path: null, text: '' };
          const text = await fs.readFile(found, 'utf8');
          return { scope, path: found, text };
        },
      }),
      defineTool({
        name: 'config_get',
        description:
          'Read a single value from the config by dot-path (e.g. "provider.model"). Returns the parsed JSON value.',
        inputSchema: z.object({ scope: scopeSchemaOptional, path: z.string().min(1) }),
        handler: async ({ scope, path: dotPath }) => {
          const found = await findScopePath(scope, cwd);
          if (!found) return null;
          const yamlMod = (await import('yaml')) as typeof import('yaml');
          const text = await fs.readFile(found, 'utf8');
          const parsed = yamlMod.parse(text) ?? {};
          const segs = parseDotPath(dotPath);
          let cursor: unknown = parsed;
          for (const seg of segs) {
            if (cursor === null || cursor === undefined) return null;
            cursor = (cursor as Record<string | number, unknown>)[seg];
          }
          return cursor ?? null;
        },
      }),
      defineTool({
        name: 'config_set',
        description:
          'Set a value at a dot-path in the moxxy config. Creates the file if missing. Value is JSON-parsed (so pass `"sonnet"`, `42`, `["a","b"]`, etc).',
        inputSchema: z.object({
          scope: scopeSchema,
          path: z.string().min(1),
          value: z.string(),
        }),
        permission: { action: 'prompt' },
        handler: async ({ scope, path: dotPath, value }) => {
          const target = (await findScopePath(scope, cwd)) ?? scopeDefaultPath(scope, cwd);
          await fs.mkdir(path.dirname(target), { recursive: true });
          const { doc, text } = await readDoc(target);
          const segs = parseDotPath(dotPath);
          const parsedValue = parseValue(value);
          doc.setIn(segs, parsedValue);
          const yamlMod = (await import('yaml')) as typeof import('yaml');

          const candidate = String(doc);
          const candidateParsed = yamlMod.parse(candidate);
          // Validate post-write through the schema so we never persist a
          // structurally-invalid config.
          const validated = moxxyConfigSchema.safeParse(candidateParsed ?? {});
          if (!validated.success) {
            throw new Error(
              `config_set would produce an invalid config:\n` +
                JSON.stringify(validated.error.issues, null, 2),
            );
          }
          await writeFileAtomic(target, candidate);

          // If a runtime applier is wired, try to reflect the change live.
          let runtime: ConfigApplyResult = { applied: [], pending: [] };
          if (applier) {
            try {
              runtime = await applier(validated.data);
            } catch (err) {
              runtime = {
                applied: [],
                pending: [`reload-failed: ${err instanceof Error ? err.message : String(err)}`],
              };
            }
          }

          return {
            path: target,
            previousSize: text.length,
            newSize: candidate.length,
            runtime,
          };
        },
      }),
      defineTool({
        name: 'config_reload',
        description:
          'Re-read the merged config from disk and apply the safe subset of changes (mode, compactor, plugin enable/disable) to the active session. Anything outside that subset is reported in `pending` and requires a restart.',
        inputSchema: z.object({}),
        handler: async () => {
          if (!applier) {
            return { applied: [], pending: ['(no runtime applier configured)'] };
          }
          const { config: fresh } = await loadConfig({ cwd });
          return await applier(fresh);
        },
      }),
      defineTool({
        name: 'config_init',
        description:
          'Create a starter moxxy config file at the given scope (yaml format), if one does not already exist.',
        inputSchema: z.object({ scope: scopeSchema }),
        permission: { action: 'prompt' },
        handler: async ({ scope }) => {
          const existing = await findScopePath(scope, cwd);
          if (existing) return { path: existing, created: false };
          const target = scopeDefaultPath(scope, cwd);
          await fs.mkdir(path.dirname(target), { recursive: true });
          const template = `# moxxy config (${scope} scope)
# Documentation: https://docs.moxxy.ai
provider:
  name: anthropic
  model: claude-sonnet-4-6
mode: tool-use
`;
          await writeFileAtomic(target, template);
          return { path: target, created: true };
        },
      }),
      defineTool({
        name: 'config_validate',
        description:
          'Re-run schema validation on the merged config (user + project) without applying any changes. Returns ok or the list of issues.',
        inputSchema: z.object({}),
        handler: async () => {
          try {
            await loadConfig({ cwd });
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    ],
  });
}
