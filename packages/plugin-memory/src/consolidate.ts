import { z, defineTool, definePlugin, type LLMProvider, type Plugin } from '@moxxy/sdk';
import type { MemoryStore} from './store.js';
import { memoryTypeSchema, type MemoryEntry, type MemoryType } from './store.js';

const SYSTEM_PROMPT = `You are consolidating overlapping long-term memory entries.

You receive a cluster of 2 or more entries that touch the same topic. Produce a single canonical entry that:
- preserves every distinct fact from the cluster (no information loss)
- removes duplication
- keeps the body under 30 lines
- picks the most informative description (one sentence, ≤120 chars)
- inherits a single 'type' from the cluster (vote: fact / preference / project / reference)

Output ONLY a JSON object with keys: { "name", "type", "description", "body", "tags" }
where name is a kebab-case slug (use the most descriptive name from the cluster).`;

const consolidatedSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  type: memoryTypeSchema,
  description: z.string().min(1).max(280),
  body: z.string().min(1).max(4000),
  tags: z.array(z.string().min(1)).optional(),
});

export interface ConsolidatePlan {
  readonly clusters: ReadonlyArray<{
    readonly key: string;
    readonly members: ReadonlyArray<string>;
  }>;
  readonly stable: ReadonlyArray<string>;
}

/**
 * Group memories into clusters by shared tag, sharing 2+ tokens in the
 * description, or both. Each cluster has at least 2 members; singletons are
 * reported as `stable` and left alone.
 */
export function planConsolidation(
  entries: ReadonlyArray<MemoryEntry>,
  opts: { tag?: string } = {},
): ConsolidatePlan {
  const filtered = opts.tag
    ? entries.filter((e) => (e.frontmatter.tags ?? []).includes(opts.tag!))
    : entries;
  if (filtered.length < 2) {
    return { clusters: [], stable: filtered.map((e) => e.frontmatter.name) };
  }

  // Primary cluster key: a shared tag. If no tag, fall back to
  // overlap of >=2 tokens in description.
  const byTag = new Map<string, MemoryEntry[]>();
  const tagless: MemoryEntry[] = [];
  for (const e of filtered) {
    const tags = e.frontmatter.tags ?? [];
    if (tags.length === 0) {
      tagless.push(e);
    } else {
      // Use the first tag as the cluster key (deterministic, simple)
      const key = tags[0]!;
      const list = byTag.get(key) ?? [];
      list.push(e);
      byTag.set(key, list);
    }
  }

  // Description-overlap clustering for the tagless tail. O(n²) but acceptable
  // for the scale we expect (hundreds of memories).
  const descClusters: Array<{ key: string; members: MemoryEntry[] }> = [];
  for (const entry of tagless) {
    const tokens = new Set(
      tokenize(entry.frontmatter.description).concat(tokenize(entry.frontmatter.name)),
    );
    let placed = false;
    for (const cluster of descClusters) {
      const clusterTokens = new Set(cluster.members.flatMap((m) => tokenize(m.frontmatter.description)));
      const overlap = [...tokens].filter((t) => clusterTokens.has(t)).length;
      if (overlap >= 2) {
        cluster.members.push(entry);
        placed = true;
        break;
      }
    }
    if (!placed) {
      descClusters.push({ key: `desc:${entry.frontmatter.name}`, members: [entry] });
    }
  }

  const clusters: Array<{ key: string; members: ReadonlyArray<string> }> = [];
  const stable: string[] = [];

  for (const [key, members] of byTag) {
    if (members.length >= 2) {
      clusters.push({ key: `tag:${key}`, members: members.map((m) => m.frontmatter.name) });
    } else {
      stable.push(members[0]!.frontmatter.name);
    }
  }
  for (const cluster of descClusters) {
    if (cluster.members.length >= 2) {
      clusters.push({ key: cluster.key, members: cluster.members.map((m) => m.frontmatter.name) });
    } else {
      stable.push(cluster.members[0]!.frontmatter.name);
    }
  }

  return { clusters, stable };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3);
}

export interface ConsolidateOptions {
  readonly tag?: string;
  readonly dryRun?: boolean;
}

export interface ConsolidationOutcome {
  readonly clusters: ReadonlyArray<{
    readonly key: string;
    readonly merged: ReadonlyArray<string>;
    readonly into: string | null;
    readonly dryRun: boolean;
  }>;
  readonly stable: ReadonlyArray<string>;
}

export async function consolidateMemory(
  store: MemoryStore,
  provider: LLMProvider,
  opts: ConsolidateOptions = {},
): Promise<ConsolidationOutcome> {
  const all = await store.list();
  const plan = planConsolidation(all, { tag: opts.tag });
  const byName = new Map(all.map((e) => [e.frontmatter.name, e]));
  const outcomes: Array<{
    key: string;
    merged: ReadonlyArray<string>;
    into: string | null;
    dryRun: boolean;
  }> = [];

  for (const cluster of plan.clusters) {
    const members = cluster.members.map((n) => byName.get(n)).filter((e): e is MemoryEntry => Boolean(e));
    if (members.length < 2) continue;

    if (opts.dryRun) {
      outcomes.push({ key: cluster.key, merged: cluster.members, into: null, dryRun: true });
      continue;
    }

    const prompt = members
      .map(
        (m, i) =>
          `[${i + 1}] name: ${m.frontmatter.name}\ntype: ${m.frontmatter.type}\ndescription: ${m.frontmatter.description}\nbody: ${m.body}`,
      )
      .join('\n\n');

    let response = '';
    for await (const event of provider.stream({
      model: provider.models[0]?.id ?? 'unknown',
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
      maxTokens: 2000,
    })) {
      if (event.type === 'text_delta') response += event.delta;
      if (event.type === 'error') {
        throw new Error(`consolidate: provider error: ${event.message}`);
      }
    }

    const extracted = extractJson(response);
    const parsed = consolidatedSchema.parse(extracted);

    // Guard: if the LLM picked a name that already exists OUTSIDE this
    // cluster, writing it would silently clobber an unrelated memory. Skip
    // the merge and record the cluster as not-merged rather than destroy
    // data.
    const clusterNames = new Set(cluster.members);
    if (byName.has(parsed.name) && !clusterNames.has(parsed.name)) {
      outcomes.push({
        key: cluster.key,
        merged: cluster.members,
        into: null,
        dryRun: false,
      });
      continue;
    }

    await store.save({
      name: parsed.name,
      type: parsed.type as MemoryType,
      description: parsed.description,
      body: parsed.body,
      ...(parsed.tags ? { tags: parsed.tags } : {}),
    });
    // Delete merged entries except the one we just saved (if it overlaps).
    for (const member of members) {
      if (member.frontmatter.name !== parsed.name) {
        await store.forget(member.frontmatter.name);
      }
    }

    outcomes.push({
      key: cluster.key,
      merged: cluster.members,
      into: parsed.name,
      dryRun: false,
    });
  }

  return { clusters: outcomes, stable: plan.stable };
}

function extractJson(text: string): unknown {
  // Take the span from the first `{` to the last `}` in the response. Some
  // providers wrap the object in ```json ... ```, which we strip first.
  const fenced = /```(?:json)?\n?([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('consolidate: model returned no JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface BuildMemoryConsolidateOptions {
  /**
   * When memory.list().length crosses this number, the plugin appends a hint
   * to the next provider request's system prompt nudging the agent to call
   * `memory_consolidate`. Default: 30. Set to 0 to disable the nudge.
   */
  readonly autoNudgeThreshold?: number;
}

export function buildMemoryConsolidatePlugin(
  store: MemoryStore,
  getProvider: () => LLMProvider,
  opts: BuildMemoryConsolidateOptions = {},
): Plugin {
  const threshold = opts.autoNudgeThreshold ?? 30;
  let nudged = false;

  return definePlugin({
    name: '@moxxy/memory-consolidate',
    version: '0.0.0',
    hooks:
      threshold > 0
        ? {
            onBeforeProviderCall: async (req) => {
              if (nudged) return; // one nudge per session
              const count = (await store.list()).length;
              if (count <= threshold) return;
              nudged = true;
              const hint =
                `\n\n[memory note] long-term memory has ${count} entries (threshold: ${threshold}). ` +
                `consider running \`memory_consolidate\` when there's a natural break to merge overlapping entries.`;
              return { ...req, system: (req.system ?? '') + hint };
            },
          }
        : {},
    tools: [
      defineTool({
        name: 'memory_consolidate',
        description:
          'Merge overlapping long-term memory entries into single canonical ones. ' +
          'Clusters by shared tag or shared tokens in name+description. ' +
          'Use dryRun=true to preview the plan without modifying anything.',
        inputSchema: z.object({
          tag: z.string().optional(),
          dryRun: z.boolean().optional().default(false),
        }),
        permission: { action: 'prompt' },
        handler: async ({ tag, dryRun }) => {
          const outcome = await consolidateMemory(store, getProvider(), {
            ...(tag ? { tag } : {}),
            ...(dryRun !== undefined ? { dryRun } : {}),
          });
          return outcome;
        },
      }),
      defineTool({
        name: 'memory_consolidate_plan',
        description: 'Return the consolidation plan (clusters that would be merged) without invoking the model.',
        inputSchema: z.object({ tag: z.string().optional() }),
        handler: async ({ tag }) => {
          const all = await store.list();
          return planConsolidation(all, { ...(tag ? { tag } : {}) });
        },
      }),
    ],
  });
}
