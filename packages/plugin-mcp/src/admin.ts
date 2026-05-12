import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineTool, definePlugin, z, type Plugin, type Skill, type ToolDef } from '@moxxy/sdk';
import type { McpClientLike, McpServerConfig, McpToolDescriptor } from './types.js';
import { wrapMcpServerTools, wrapMcpServerToolsLazy } from './wrap.js';

/**
 * Minimal skill-registry shape the admin plugin needs to auto-register
 * a usage skill after `mcp_add_server`. Loose typing to keep this plugin
 * free of an explicit @moxxy/core import.
 */
export interface AdminSkillRegistryLike {
  register(skill: Skill): void;
  byName(name: string): Skill | undefined;
}

/**
 * Live runtime: live MCP clients keyed by server name plus the set of
 * tool names each one registered into the session. Lets us close +
 * unregister on `mcp_remove_server` and on shutdown without
 * rediscovering anything. Module-scoped so the admin plugin and the
 * shutdown hook share the same state; each Session that loads the
 * plugin gets its own map via the closure in `buildMcpAdminPlugin`.
 */
export interface McpRuntimeHandle {
  readonly client: McpClientLike;
  readonly toolNames: ReadonlyArray<string>;
}

/**
 * Tool-registry surface the admin plugin uses to hot-attach / detach
 * MCP tools. Matches the `ToolRegistry` in @moxxy/core but typed loosely
 * so we don't add an internal-dep on core from this plugin.
 */
export interface AdminToolRegistryLike {
  has(name: string): boolean;
  register(tool: ToolDef): void;
  unregister(name: string): void;
}

/**
 * User-level MCP server catalog persisted at ~/.moxxy/mcp.json. Mutated
 * by the admin tools below; read at boot by @moxxy/cli setup to spin up
 * connection plugins. JSON (not yaml) for trivial parse/write — these
 * entries are programmatically managed, the user doesn't normally edit
 * them by hand.
 */
/**
 * On-disk catalog entry: connection config PLUS a cache of the tool
 * descriptors the server last advertised, plus an enable/disable flag.
 *
 * Defined as an intersection (not `extends`) so the McpServerConfig
 * discriminated union is preserved — `extends` would collapse it.
 */
export type McpStoredServer = McpServerConfig & {
  readonly cachedTools?: ReadonlyArray<McpToolDescriptor>;
  /** When true, the boot loader skips this entry — no lazy stubs are
   *  registered and tools stay invisible. Lets the user keep the
   *  connection config for later without paying for tool registration. */
  readonly disabled?: boolean;
};

export interface McpStoredConfig {
  readonly servers: ReadonlyArray<McpStoredServer>;
}

export function mcpConfigPath(): string {
  return path.join(os.homedir(), '.moxxy', 'mcp.json');
}

export async function readMcpConfig(): Promise<McpStoredConfig> {
  try {
    const raw = await fs.readFile(mcpConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as McpStoredConfig).servers)) {
      return parsed as McpStoredConfig;
    }
  } catch {
    // missing or malformed — treat as empty
  }
  return { servers: [] };
}

/**
 * Set a server's `disabled` flag in mcp.json. Used by both `moxxy mcp
 * enable/disable` (CLI) and the `/mcp` slash command (TUI) — those
 * paths bypass the model and write directly. Returns the updated entry,
 * or null if no server with that name exists.
 *
 * Runtime detach (when disabling) and lazy re-attach (when enabling)
 * are NOT performed here — callers in a live session need to call into
 * the admin plugin's runtime API for that.
 */
export async function setServerDisabled(name: string, disabled: boolean): Promise<McpStoredServer | null> {
  const cfg = await readMcpConfig();
  const idx = cfg.servers.findIndex((s) => s.name === name);
  if (idx < 0) return null;
  const updated: McpStoredServer = { ...cfg.servers[idx]!, disabled };
  const nextServers = [...cfg.servers];
  nextServers[idx] = updated;
  await writeMcpConfig({ servers: nextServers });
  return updated;
}

/**
 * Drop a server from the catalog by name. Returns true if anything was
 * removed. Does NOT touch a live session's tool registry.
 */
export async function removeServerFromConfig(name: string): Promise<boolean> {
  const cfg = await readMcpConfig();
  const before = cfg.servers.length;
  const next = cfg.servers.filter((s) => s.name !== name);
  if (next.length === before) return false;
  await writeMcpConfig({ servers: next });
  return true;
}

export async function writeMcpConfig(cfg: McpStoredConfig): Promise<void> {
  const target = mcpConfigPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Atomic-ish write: temp file + rename so a crash mid-write can't
  // leave a half-flushed JSON blob that fails to parse next boot.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
}

const serverNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be slug-like (lowercase letters, digits, hyphens)');

// Flat schema (no discriminated union) so OpenAI's function-calling
// validator accepts it. OpenAI rejects top-level oneOf/anyOf with
// "object schema missing properties"; the model now sees a single
// object with `kind` + every transport-specific field optional, plus
// a runtime guard in the handler that enforces the per-kind required
// set with a readable error.
const addServerInput = z.object({
  kind: z.enum(['stdio', 'http', 'sse']).describe(
    'Transport kind. "stdio" runs a local executable; "http" and "sse" connect to a remote URL.',
  ),
  name: serverNameSchema,
  // stdio-only fields
  command: z
    .string()
    .min(1)
    .optional()
    .describe('Required when kind="stdio". Executable to spawn (e.g. "npx", "uv", "python").'),
  args: z
    .array(z.string())
    .optional()
    .describe('Optional when kind="stdio". CLI arguments for the executable.'),
  env: z
    .record(z.string())
    .optional()
    .describe('Optional when kind="stdio". Environment variables for the spawned process.'),
  cwd: z
    .string()
    .optional()
    .describe('Optional when kind="stdio". Working directory for the spawned process.'),
  // http/sse-only fields
  url: z
    .string()
    .url()
    .optional()
    .describe('Required when kind="http" or "sse". Server URL.'),
  headers: z
    .record(z.string())
    .optional()
    .describe('Optional when kind="http" or "sse". HTTP headers (auth, etc).'),
  autoSkill: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'When true (default), auto-write a deterministic usage skill ' +
        '<server-name>-mcp.md into ~/.moxxy/skills/ documenting the ' +
        'tools the server exposes. Pass false if the user explicitly ' +
        'asked for no skill.',
    ),
});

type AddServerInput = z.infer<typeof addServerInput>;

function validateAddServerInput(input: AddServerInput): McpServerConfig {
  // autoSkill is consumed by the handler, not by the connection factory —
  // strip it before constructing the McpServerConfig.
  void input.autoSkill;
  if (input.kind === 'stdio') {
    if (!input.command) {
      throw new Error(
        'mcp_add_server: kind="stdio" requires a `command` field (e.g. "npx", "uv", "python").',
      );
    }
    const out: McpServerConfig = {
      kind: 'stdio',
      name: input.name,
      command: input.command,
      ...(input.args ? { args: input.args } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    return out;
  }
  if (!input.url) {
    throw new Error(
      `mcp_add_server: kind="${input.kind}" requires a \`url\` field (the remote MCP endpoint).`,
    );
  }
  return {
    kind: input.kind,
    name: input.name,
    url: input.url,
    ...(input.headers ? { headers: input.headers } : {}),
  };
}

export interface BuildMcpAdminPluginOptions {
  /**
   * Live tool registry. When provided, `mcp_add_server` connects + wraps
   * the server immediately and registers its tools into this registry —
   * no restart needed. `mcp_remove_server` closes the client and
   * unregisters. Pass `null` for pure-config behavior (write-only).
   */
  readonly toolRegistry: AdminToolRegistryLike | null;
  /**
   * Skill registry + skills dir. When provided, `mcp_add_server`
   * auto-writes a deterministic usage skill (server-name + tool catalog)
   * to disk and registers it so `/skills` and the system-prompt index
   * surface the MCP server alongside hand-authored skills. The skill is
   * generated from descriptors directly — no model call. Pass `null` to
   * disable auto-skill creation.
   */
  readonly skillRegistry?: AdminSkillRegistryLike | null;
  readonly userSkillsDir?: string;
}

/**
 * Build the MCP admin plugin: tools that let the agent register and
 * manage MCP servers at runtime. When wired to a live tool registry,
 * adds hot-attach so newly-registered servers are callable in the same
 * session without a restart.
 */
/**
 * Runtime control surface exposed alongside the admin Plugin. The TUI's
 * /mcp slash command and the CLI's `moxxy mcp` subcommand use this to
 * detach a server's live tools when disabling, or re-attach when
 * enabling, without going through the model.
 */
export interface McpAdminApi {
  /** Refresh + lazy-attach a server (used after enabling). */
  enableAndAttach(name: string): Promise<{ toolNames: ReadonlyArray<string> } | null>;
  /** Detach a server's live tools and close its client. */
  detach(name: string): Promise<boolean>;
}

export function buildMcpAdminPluginWithApi(
  opts: BuildMcpAdminPluginOptions = { toolRegistry: null },
): { plugin: Plugin; api: McpAdminApi } {
  const result = buildMcpAdminPluginInternal(opts);
  return result;
}

export function buildMcpAdminPlugin(opts: BuildMcpAdminPluginOptions = { toolRegistry: null }): Plugin {
  return buildMcpAdminPluginInternal(opts).plugin;
}

function buildMcpAdminPluginInternal(
  opts: BuildMcpAdminPluginOptions,
): { plugin: Plugin; api: McpAdminApi } {
  const registry = opts.toolRegistry;
  const skillRegistry = opts.skillRegistry ?? null;
  const userSkillsDir = opts.userSkillsDir ?? path.join(os.homedir(), '.moxxy', 'skills');

  /**
   * Compose a deterministic usage skill from the server's tool list.
   * Cheaper and more reliable than a synthesize_skill model call — the
   * descriptors already carry name + description, so the skill body just
   * lays them out as a bulleted checklist. The user can edit the file
   * later if they want a richer playbook.
   */
  const writeMcpUsageSkill = async (
    server: McpServerConfig,
    descriptors: ReadonlyArray<McpToolDescriptor>,
  ): Promise<{ path: string; skillName: string } | null> => {
    const skillName = `${server.name}-mcp`;
    if (skillRegistry?.byName(skillName)) {
      // Already exists (likely from a previous attach) — leave it alone
      // so user edits aren't clobbered.
      return null;
    }
    const triggers = [server.name, `${server.name} mcp`, `use ${server.name}`];
    const toolBullets = descriptors
      .map((d) => {
        const wrappedName = `mcp__${server.name}__${d.name}`;
        return `- \`${wrappedName}\` — ${d.description ?? '(no description provided)'}`;
      })
      .join('\n');
    const allowed = descriptors.map((d) => `mcp__${server.name}__${d.name}`);
    const description = `Use the ${server.name} MCP server (${descriptors.length} tools).`.slice(0, 240);
    const frontmatter =
      `---\n` +
      `name: ${skillName}\n` +
      `description: ${description}\n` +
      `triggers:\n${triggers.map((t) => `  - "${t}"`).join('\n')}\n` +
      `allowed-tools:\n${allowed.map((a) => `  - ${a}`).join('\n')}\n` +
      `---\n`;
    const body =
      `When the user wants to work with **${server.name}**, use the MCP tools below. Pick the tool that best matches the user's intent; chain multiple if needed.\n\n` +
      `## Available tools\n\n${toolBullets}\n\n` +
      `## Notes\n\n` +
      `- Every tool above is namespaced \`mcp__${server.name}__*\`.\n` +
      `- Auto-generated when the MCP server was registered. Edit this file by hand to refine the playbook.`;
    const raw = `${frontmatter}\n${body}\n`;
    const filePath = path.join(userSkillsDir, `${skillName}.md`);
    await fs.mkdir(userSkillsDir, { recursive: true });
    await fs.writeFile(filePath, raw, 'utf8');
    if (skillRegistry) {
      // Build a Skill object that mirrors what discoverSkills would
      // produce so /skills, the system-prompt index, and load_skill all
      // see it immediately.
      const skillObject: Skill = {
        id: `user/${skillName}` as Skill['id'],
        path: filePath,
        scope: 'user',
        frontmatter: {
          name: skillName,
          description,
          triggers,
          'allowed-tools': allowed,
        } as Skill['frontmatter'],
        body,
      };
      try {
        skillRegistry.register(skillObject);
      } catch {
        // already registered — fine
      }
    }
    return { path: filePath, skillName };
  };
  // Track hot-attached runtimes keyed by server name. We need to know
  // which tools each server contributed so `mcp_remove_server` can
  // unregister them cleanly, and which client to close on shutdown.
  const runtimes = new Map<string, McpRuntimeHandle>();

  /**
   * Eager attach used by `mcp_add_server`: connect, list tools, register
   * them. Returns the discovered descriptors so the caller can cache
   * them into mcp.json for lazy boots next time.
   */
  const attachServer = async (
    server: McpServerConfig,
  ): Promise<{ toolNames: ReadonlyArray<string>; descriptors: ReadonlyArray<McpToolDescriptor> }> => {
    const { defaultClientFactory } = await import('./index.js');
    const client = await defaultClientFactory(server);
    const list = await client.listTools();
    const descriptors = list.tools;
    const wrapped = await wrapMcpServerTools({ server, client });
    if (!registry) {
      await client.close();
      return { toolNames: wrapped.map((t) => t.name), descriptors };
    }
    const collisions = wrapped.filter((t) => registry.has(t.name)).map((t) => t.name);
    if (collisions.length > 0) {
      await client.close();
      throw new Error(
        `mcp_add_server: tool name collision — already registered: ${collisions.join(', ')}. ` +
          'Pick a different server name (the server name becomes a prefix on each tool).',
      );
    }
    for (const tool of wrapped) registry.register(tool);
    runtimes.set(server.name, { client, toolNames: wrapped.map((t) => t.name) });
    return { toolNames: wrapped.map((t) => t.name), descriptors };
  };

  /**
   * Lazy attach used at boot: register stub tools using cached
   * descriptors WITHOUT connecting. The first call to any of these
   * tools triggers a single shared connection via `getOrConnect`;
   * subsequent calls reuse it. Failed connections reset so the next
   * call can retry.
   *
   * When `cachedTools` is missing (catalog entry predates the cache
   * feature or was edited by hand), the caller is responsible for
   * refreshing the cache first via `refreshServerCache`.
   */
  const attachServerLazy = (
    server: McpStoredServer,
  ): { toolNames: ReadonlyArray<string> } => {
    if (!registry) return { toolNames: [] };
    if (runtimes.has(server.name)) return { toolNames: runtimes.get(server.name)!.toolNames };
    const descriptors = server.cachedTools ?? [];
    if (descriptors.length === 0) {
      return { toolNames: [] };
    }

    let connectPromise: Promise<McpClientLike> | null = null;
    const getOrConnect = async (): Promise<McpClientLike> => {
      if (!connectPromise) {
        connectPromise = (async () => {
          const { defaultClientFactory } = await import('./index.js');
          const client = await defaultClientFactory(server);
          // Stash the live client on the runtime entry so shutdown can
          // close it. The entry was created with a sentinel; replace it.
          const runtime = runtimes.get(server.name);
          if (runtime) {
            runtimes.set(server.name, { client, toolNames: runtime.toolNames });
          }
          return client;
        })().catch((err) => {
          // Reset so a future call can retry instead of being stuck on
          // a rejected promise.
          connectPromise = null;
          throw err;
        });
      }
      return connectPromise;
    };

    const wrapped = wrapMcpServerToolsLazy({ server, descriptors, getClient: getOrConnect });
    const collisions = wrapped.filter((t) => registry.has(t.name)).map((t) => t.name);
    if (collisions.length > 0) {
      throw new Error(
        `lazy attach: tool name collision for "${server.name}": ${collisions.join(', ')}. ` +
          'A different server (or a previously-attached version) already owns these names.',
      );
    }
    for (const tool of wrapped) registry.register(tool);
    // Sentinel client gets swapped for the real one inside getOrConnect.
    // Until first call, close() is a no-op via the LazyClient sentinel.
    const lazyClient: McpClientLike = {
      listTools: async () => ({ tools: descriptors }),
      callTool: async (args) => (await getOrConnect()).callTool(args),
      close: async () => {
        if (connectPromise) {
          const client = await connectPromise.catch(() => null);
          if (client) await client.close();
        }
      },
    };
    runtimes.set(server.name, { client: lazyClient, toolNames: wrapped.map((t) => t.name) });
    return { toolNames: wrapped.map((t) => t.name) };
  };

  /**
   * Connect to a server, list its tools, and write the descriptors back
   * to mcp.json. Used to refresh stale or missing caches at boot. The
   * connection is closed immediately — registration happens via the
   * caller's subsequent `attachServerLazy` call.
   */
  const refreshServerCache = async (
    server: McpStoredServer,
  ): Promise<McpStoredServer> => {
    const { defaultClientFactory } = await import('./index.js');
    const client = await defaultClientFactory(server);
    try {
      const list = await client.listTools();
      const refreshed: McpStoredServer = { ...server, cachedTools: list.tools };
      // Persist the refreshed cache so subsequent boots can lazy-attach
      // without reconnecting.
      const cfg = await readMcpConfig();
      const nextServers = cfg.servers.map((s) => (s.name === server.name ? refreshed : s));
      await writeMcpConfig({ servers: nextServers });
      return refreshed;
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  };

  const detachServer = async (name: string): Promise<boolean> => {
    const runtime = runtimes.get(name);
    if (!runtime) return false;
    runtimes.delete(name);
    if (registry) {
      for (const toolName of runtime.toolNames) registry.unregister(toolName);
    }
    try {
      await runtime.client.close();
    } catch {
      // ignore — best-effort close
    }
    return true;
  };

  const api: McpAdminApi = {
    enableAndAttach: async (name) => {
      const cfg = await readMcpConfig();
      const found = cfg.servers.find((s) => s.name === name);
      if (!found) return null;
      let entry: McpStoredServer = found;
      if (!entry.cachedTools || entry.cachedTools.length === 0) {
        entry = await refreshServerCache(entry);
      }
      return attachServerLazy(entry);
    },
    detach: detachServer,
  };
  const plugin = definePlugin({
    name: '@moxxy/plugin-mcp-admin',
    version: '0.0.0',
    tools: [
      defineTool({
        name: 'mcp_list_servers',
        description:
          'List every MCP server currently registered in ~/.moxxy/mcp.json. Returns name + transport kind + connection details (command/url) for each.',
        inputSchema: z.object({}),
        handler: async () => {
          const cfg = await readMcpConfig();
          return cfg.servers.map((s) =>
            s.kind === undefined || s.kind === 'stdio'
              ? { name: s.name, kind: 'stdio' as const, command: (s as { command: string }).command }
              : { name: s.name, kind: s.kind, url: (s as { url: string }).url },
          );
        },
      }),
      defineTool({
        name: 'mcp_add_server',
        description:
          'Register a new MCP server in ~/.moxxy/mcp.json. Pick "stdio" for local commands ' +
          '(npm/uv packages, scripts); pick "http" or "sse" for remote HTTP servers. The new ' +
          'server\'s tools become available after the next moxxy restart. Call mcp_test_server ' +
          'first if you want to verify connectivity before persisting.',
        inputSchema: addServerInput,
        permission: { action: 'prompt' },
        handler: async (input) => {
          const server = validateAddServerInput(input);
          const cfg = await readMcpConfig();
          if (cfg.servers.some((s) => s.name === server.name)) {
            throw new Error(
              `mcp_add_server: an MCP server named "${server.name}" already exists. ` +
                `Use mcp_remove_server first, or pick a different name.`,
            );
          }
          // Hot-attach: connect + register tools BEFORE persisting. If
          // attach fails (bad URL, missing command, schema mismatch),
          // we never write a broken entry to disk.
          const { toolNames, descriptors } = await attachServer(server);
          // Cache descriptors so next boot can register lazy stubs
          // without paying the connection cost up-front.
          const stored: McpStoredServer = { ...server, cachedTools: descriptors };
          const next: McpStoredConfig = { servers: [...cfg.servers, stored] };
          await writeMcpConfig(next);
          // Auto-create the usage skill so /skills surfaces the new
          // server alongside hand-authored skills. Best-effort — if
          // skill writing fails, the MCP attach still succeeded.
          let skillResult: { path: string; skillName: string } | null = null;
          if (input.autoSkill !== false) {
            try {
              skillResult = await writeMcpUsageSkill(server, descriptors);
            } catch (err) {
              skillResult = null;
              // surface but don't fail the whole tool call
              return {
                ok: true,
                name: server.name,
                path: mcpConfigPath(),
                attached: registry !== null,
                tools: toolNames,
                skill: null,
                skillError: err instanceof Error ? err.message : String(err),
                note: 'Server attached + persisted; skill creation failed (see skillError).',
              };
            }
          }
          return {
            ok: true,
            name: server.name,
            path: mcpConfigPath(),
            attached: registry !== null,
            tools: toolNames,
            skill: skillResult,
            note: registry
              ? `Live in this session — ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'} now callable.` +
                (skillResult ? ` Usage skill written to ${skillResult.path}.` : '') +
                ' Persisted; survives restart.'
              : 'Saved to config. Restart moxxy to load the tools (no live registry was wired into the admin plugin).',
          };
        },
      }),
      defineTool({
        name: 'mcp_remove_server',
        description:
          'Remove an MCP server from ~/.moxxy/mcp.json and detach its tools from the live session. ' +
          'The tools become uncallable immediately and the entry is gone on next restart.',
        inputSchema: z.object({ name: serverNameSchema }),
        permission: { action: 'prompt' },
        handler: async ({ name }) => {
          const cfg = await readMcpConfig();
          const before = cfg.servers.length;
          const next: McpStoredConfig = {
            servers: cfg.servers.filter((s) => s.name !== name),
          };
          const persisted = next.servers.length !== before;
          const detached = await detachServer(name);
          if (persisted) await writeMcpConfig(next);
          if (!persisted && !detached) {
            return { removed: false, name, note: `No MCP server named "${name}" was registered.` };
          }
          return {
            removed: true,
            name,
            persistedChange: persisted,
            detachedFromSession: detached,
          };
        },
      }),
      defineTool({
        name: 'mcp_test_server',
        description:
          'Connect to an MCP server WITHOUT saving it to config. Returns the list of tools the ' +
          'server exposes if the connection succeeds, or a connection-error message. Useful for ' +
          'sanity-checking before calling mcp_add_server.',
        inputSchema: addServerInput,
        handler: async (input) => {
          const server = validateAddServerInput(input);
          // Local import: keep the @modelcontextprotocol/sdk dependency
          // lazy so admin tools don't pay the import cost when the
          // session never tests anything.
          const { defaultClientFactory } = await import('./index.js');
          let client: Awaited<ReturnType<typeof defaultClientFactory>> | null = null;
          try {
            client = await defaultClientFactory(server);
            const wrapped = await wrapMcpServerTools({ server, client });
            return {
              ok: true,
              name: server.name,
              tools: wrapped.map((t) => ({ name: t.name, description: t.description })),
            };
          } catch (err) {
            return {
              ok: false,
              name: server.name,
              error: err instanceof Error ? err.message : String(err),
            };
          } finally {
            if (client) {
              try {
                await client.close();
              } catch {
                /* ignore */
              }
            }
          }
        },
      }),
    ],
    hooks: {
      // On session init, register lazy stubs for every saved MCP server.
      // Servers WITH a tool-descriptor cache register stubs instantly
      // (no connection). Servers WITHOUT a cache (entry predates the
      // cache feature, edited by hand, etc.) auto-refresh — we connect
      // once, list tools, write the cache back to mcp.json, then
      // register lazy stubs. The connection is closed after listing;
      // subsequent tool calls reconnect via the lazy path.
      onInit: async (ctx) => {
        if (!registry) return;
        const log = (ctx as { logger?: { warn: (msg: string, meta?: unknown) => void } }).logger;
        let cfg: McpStoredConfig;
        try {
          cfg = await readMcpConfig();
        } catch {
          return;
        }
        for (const server of cfg.servers) {
          if (server.disabled) continue;
          let entry: McpStoredServer = server;
          if (!entry.cachedTools || entry.cachedTools.length === 0) {
            try {
              entry = await refreshServerCache(entry);
            } catch (err) {
              log?.warn?.(`mcp: failed to refresh cache for "${entry.name}"`, {
                err: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
          }
          try {
            attachServerLazy(entry);
          } catch (err) {
            log?.warn?.(`mcp: failed to attach lazy stubs for "${entry.name}"`, {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
      // Close every attached MCP client (lazy or eager) on session
      // shutdown so stdio child processes don't get orphaned and HTTP
      // sockets don't leak.
      onShutdown: async () => {
        for (const [, runtime] of runtimes) {
          try {
            await runtime.client.close();
          } catch {
            /* ignore */
          }
        }
        runtimes.clear();
      },
    },
  });
  return { plugin, api };
}
