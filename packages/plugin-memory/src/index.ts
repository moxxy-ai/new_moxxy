import { defineTool, definePlugin, z, type Plugin } from '@moxxy/sdk';
import { MemoryStore, memoryTypeSchema, type MemoryStoreOptions } from './store.js';

export {
  MemoryStore,
  memoryTypeSchema,
  memoryFrontmatterSchema,
  defaultMemoryDir,
  type MemoryEntry,
  type MemoryFrontmatter,
  type MemoryStoreOptions,
  type MemoryType,
  type RankedMemory,
  type RecallMode,
} from './store.js';
export { parseMdFile, parseFrontmatter, renderFrontmatter } from './parse.js';
export { recentExchanges, summarizeSession, type SessionFact } from './stm.js';
export { TfIdfEmbedder, cosineSimilarity, tokenize } from './tfidf.js';
export { EmbeddingIndex } from './embedding-cache.js';
export {
  planConsolidation,
  consolidateMemory,
  buildMemoryConsolidatePlugin,
  type ConsolidatePlan,
  type ConsolidateOptions,
  type ConsolidationOutcome,
} from './consolidate.js';

export interface BuildMemoryPluginOptions extends MemoryStoreOptions {}

export function buildMemoryPlugin(opts: BuildMemoryPluginOptions = {}): { plugin: Plugin; store: MemoryStore } {
  const store = new MemoryStore(opts);
  const plugin = definePlugin({
    name: '@moxxy/plugin-memory',
    version: '0.0.0',
    tools: [
      defineTool({
        name: 'memory_save',
        description:
          'Persist a memory to long-term storage. Use sparingly — only for facts/preferences/' +
          'project context that would help you in future sessions. Keep the body terse.',
        inputSchema: z.object({
          name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be slug-like'),
          type: memoryTypeSchema,
          description: z.string().min(1).max(280),
          body: z.string().min(1).max(4000),
          tags: z.array(z.string().min(1)).optional(),
        }),
        permission: { action: 'prompt' },
        isolation: {
          capabilities: {
            fs: { read: ['~/.moxxy/memory/**'], write: ['~/.moxxy/memory/**'] },
            net: { mode: 'none' },
            timeMs: 5_000,
          },
        },
        handler: async ({ name, type, description, body, tags }) => {
          const saved = await store.save({ name, type, description, body, tags });
          return { name: saved.frontmatter.name, path: saved.path };
        },
      }),
      defineTool({
        name: 'memory_recall',
        description:
          'Search long-term memory by free-text query. Uses vector similarity (TF-IDF by default, ' +
          'or a configured EmbeddingProvider) when mode is "auto" or "vector". Returns the most ' +
          'relevant entries with their full bodies.',
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(20).optional().default(5),
          type: memoryTypeSchema.optional(),
          mode: z.enum(['auto', 'vector', 'keyword']).optional().default('auto'),
        }),
        isolation: {
          capabilities: {
            fs: { read: ['~/.moxxy/memory/**'] },
            // Vector recall may call out to an EmbeddingProvider (OpenAI,
            // local transformers, …). The inproc isolator can't enforce
            // this; a stronger isolator should constrain to the actual
            // configured embedder's host.
            net: { mode: 'any' },
            timeMs: 15_000,
          },
        },
        handler: async ({ query, limit, type, mode }) => {
          const matches = await store.recall(query, { limit, type, mode });
          return matches.map(({ entry, score }) => ({
            name: entry.frontmatter.name,
            type: entry.frontmatter.type,
            description: entry.frontmatter.description,
            body: entry.body,
            score,
          }));
        },
      }),
      defineTool({
        name: 'memory_list',
        description: 'List all stored memories (name + type + description, no body).',
        inputSchema: z.object({ type: memoryTypeSchema.optional() }),
        isolation: {
          capabilities: {
            fs: { read: ['~/.moxxy/memory/**'] },
            net: { mode: 'none' },
            timeMs: 5_000,
          },
        },
        handler: async ({ type }) => {
          const entries = await store.list(type);
          return entries.map((e) => ({
            name: e.frontmatter.name,
            type: e.frontmatter.type,
            description: e.frontmatter.description,
            tags: e.frontmatter.tags ?? [],
          }));
        },
      }),
      defineTool({
        name: 'memory_forget',
        description: 'Delete a memory by name. Use only when the memory is incorrect or no longer relevant.',
        inputSchema: z.object({ name: z.string().min(1) }),
        permission: { action: 'prompt' },
        isolation: {
          capabilities: {
            fs: { read: ['~/.moxxy/memory/**'], write: ['~/.moxxy/memory/**'] },
            net: { mode: 'none' },
            timeMs: 5_000,
          },
        },
        handler: async ({ name }) => {
          const removed = await store.forget(name);
          return removed ? `forgot ${name}` : `not found: ${name}`;
        },
      }),
      defineTool({
        name: 'memory_update',
        description: 'Update an existing memory in place. createdAt is preserved; updatedAt bumps.',
        inputSchema: z.object({
          name: z.string().min(1),
          description: z.string().min(1).max(280).optional(),
          body: z.string().min(1).max(4000).optional(),
          tags: z.array(z.string().min(1)).optional(),
        }),
        permission: { action: 'prompt' },
        isolation: {
          capabilities: {
            fs: { read: ['~/.moxxy/memory/**'], write: ['~/.moxxy/memory/**'] },
            net: { mode: 'none' },
            timeMs: 5_000,
          },
        },
        handler: async ({ name, description, body, tags }) => {
          const updated = await store.update(name, { description, body, tags });
          if (!updated) throw new Error(`memory '${name}' not found`);
          return { name: updated.frontmatter.name, updatedAt: updated.frontmatter.updatedAt };
        },
      }),
    ],
  });
  return { plugin, store };
}
