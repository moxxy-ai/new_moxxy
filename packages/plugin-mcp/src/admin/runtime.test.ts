import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpClientLike, McpServerConfig, McpToolDescriptor } from '../types.js';
import type { AdminToolRegistryLike, McpStoredServer } from './types.js';

// The runtime connects through `defaultClientFactory` (from ../client.js),
// which would spawn a real subprocess / open a real socket. Replace it with
// an injectable fake whose behavior each test controls via `connectImpl`.
const hoisted = vi.hoisted(() => {
  return {
    connectCalls: [] as McpServerConfig[],
    connectImpl: null as ((server: McpServerConfig) => Promise<McpClientLike>) | null,
  };
});

vi.mock('../client.js', () => ({
  defaultClientFactory: async (server: McpServerConfig): Promise<McpClientLike> => {
    hoisted.connectCalls.push(server);
    if (!hoisted.connectImpl) throw new Error('connectImpl not set by test');
    return hoisted.connectImpl(server);
  },
}));

// Imported AFTER the mock is registered (vi.mock is hoisted above imports).
const { createMcpRuntime } = await import('./runtime.js');
const { readMcpConfig, writeMcpConfig } = await import('./config-io.js');

const PING: McpToolDescriptor = { name: 'ping', description: 'pong', inputSchema: { type: 'object' } };

const makeClient = (over: Partial<McpClientLike> = {}): McpClientLike & { closed: number } => {
  const state = { closed: 0 };
  return {
    closed: 0,
    async listTools() {
      return { tools: [PING] };
    },
    async callTool({ name }) {
      return { content: [{ type: 'text', text: `pong ${name}` }] };
    },
    async close() {
      state.closed++;
      (this as { closed: number }).closed = state.closed;
    },
    ...over,
  } as McpClientLike & { closed: number };
};

const makeRegistry = (): AdminToolRegistryLike & { tools: Map<string, unknown> } => {
  const tools = new Map<string, unknown>();
  return {
    tools,
    has: (n) => tools.has(n),
    register: (t) => {
      if (tools.has(t.name)) throw new Error(`dup register ${t.name}`);
      tools.set(t.name, t);
    },
    unregister: (n) => void tools.delete(n),
  };
};

const stored = (over: Partial<McpStoredServer> = {}): McpStoredServer =>
  ({ kind: 'stdio', name: 'demo', command: 'noop', cachedTools: [PING], ...over }) as McpStoredServer;

const baseCtx = () => ({
  sessionId: 's' as never,
  turnId: 't' as never,
  callId: 'c' as never,
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

describe('admin/runtime', () => {
  let home: string;
  const original = process.env.MOXXY_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moxxy-mcp-rt-'));
    process.env.MOXXY_HOME = home;
    hoisted.connectCalls.length = 0;
    hoisted.connectImpl = null;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.MOXXY_HOME;
    else process.env.MOXXY_HOME = original;
    await rm(home, { recursive: true, force: true });
  });

  describe('attachServer (eager)', () => {
    it('throws on a tool-name collision and closes the freshly-opened client', async () => {
      const registry = makeRegistry();
      // Pre-register the name the server would produce.
      registry.register({ name: 'mcp__demo__ping' } as never);
      const client = makeClient();
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(registry);
      await expect(rt.attachServer({ kind: 'stdio', name: 'demo', command: 'x' })).rejects.toThrow(
        /tool name collision/,
      );
      // Client must not leak when we bail on collision.
      expect(client.closed).toBe(1);
      // No runtime entry recorded for a failed attach.
      expect(rt.runtimes.has('demo')).toBe(false);
    });

    it('registers wrapped tools and records a runtime handle on success', async () => {
      const registry = makeRegistry();
      const client = makeClient();
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(registry);
      const { toolNames, descriptors } = await rt.attachServer({ kind: 'stdio', name: 'demo', command: 'x' });
      expect(toolNames).toEqual(['mcp__demo__ping']);
      expect(descriptors).toEqual([PING]);
      expect(registry.has('mcp__demo__ping')).toBe(true);
      expect(rt.runtimes.get('demo')?.toolNames).toEqual(['mcp__demo__ping']);
    });

    it('closes the client (no registration) when there is no registry', async () => {
      const client = makeClient();
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(null);
      const { toolNames } = await rt.attachServer({ kind: 'stdio', name: 'demo', command: 'x' });
      expect(toolNames).toEqual(['mcp__demo__ping']);
      expect(client.closed).toBe(1);
      expect(rt.runtimes.has('demo')).toBe(false);
    });
  });

  describe('attachServerLazy', () => {
    it('registers stubs WITHOUT connecting', () => {
      const registry = makeRegistry();
      const rt = createMcpRuntime(registry);
      const { toolNames } = rt.attachServerLazy(stored());
      expect(toolNames).toEqual(['mcp__demo__ping']);
      expect(registry.has('mcp__demo__ping')).toBe(true);
      // No connection until a tool actually runs.
      expect(hoisted.connectCalls).toHaveLength(0);
    });

    it('skips servers with no cached tools', () => {
      const registry = makeRegistry();
      const rt = createMcpRuntime(registry);
      const { toolNames } = rt.attachServerLazy(stored({ cachedTools: [] }));
      expect(toolNames).toEqual([]);
      expect(rt.runtimes.has('demo')).toBe(false);
    });

    it('is idempotent when the server is already attached', () => {
      const registry = makeRegistry();
      const rt = createMcpRuntime(registry);
      rt.attachServerLazy(stored());
      // Second call must not throw a collision against its own prior stubs.
      const { toolNames } = rt.attachServerLazy(stored());
      expect(toolNames).toEqual(['mcp__demo__ping']);
    });

    it('lazy sentinel close() is a no-op until the first call connects', async () => {
      const registry = makeRegistry();
      const rt = createMcpRuntime(registry);
      rt.attachServerLazy(stored());
      const handle = rt.runtimes.get('demo')!;
      // Closing before any tool runs must not connect or throw.
      await handle.client.close();
      expect(hoisted.connectCalls).toHaveLength(0);
    });

    it('first tool call triggers one shared connection; subsequent calls reuse it', async () => {
      const registry = makeRegistry();
      const client = makeClient();
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(registry);
      rt.attachServerLazy(stored());
      const tool = registry.tools.get('mcp__demo__ping') as {
        handler: (i: unknown, c: unknown) => Promise<unknown>;
      };
      await tool.handler({}, baseCtx());
      await tool.handler({}, baseCtx());
      expect(hoisted.connectCalls).toHaveLength(1);
      // The live client replaced the sentinel on the runtime handle.
      expect(rt.runtimes.get('demo')?.client).toBe(client);
    });

    it('getOrConnect retries after a failed connect instead of caching the rejection', async () => {
      const registry = makeRegistry();
      const good = makeClient();
      let attempt = 0;
      hoisted.connectImpl = async () => {
        attempt++;
        if (attempt === 1) throw new Error('connect boom');
        return good;
      };
      const rt = createMcpRuntime(registry);
      rt.attachServerLazy(stored());
      const tool = registry.tools.get('mcp__demo__ping') as {
        handler: (i: unknown, c: unknown) => Promise<unknown>;
      };
      // First call fails...
      await expect(tool.handler({}, baseCtx())).rejects.toThrow(/connect boom/);
      // ...but the connect promise was reset, so a retry succeeds.
      const out = await tool.handler({}, baseCtx());
      expect(out).toBe('pong ping');
      expect(attempt).toBe(2);
    });

    it('throws and does not register on a cross-server name collision', () => {
      const registry = makeRegistry();
      registry.register({ name: 'mcp__demo__ping' } as never);
      const rt = createMcpRuntime(registry);
      expect(() => rt.attachServerLazy(stored())).toThrow(/tool name collision/);
    });
  });

  describe('refreshServerCache', () => {
    it('connects, persists discovered descriptors, and closes the client', async () => {
      await writeMcpConfig({ servers: [{ kind: 'stdio', name: 'demo', command: 'noop' }] });
      const client = makeClient();
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(makeRegistry());
      const refreshed = await rt.refreshServerCache(stored({ cachedTools: undefined }));
      expect(refreshed.cachedTools).toEqual([PING]);
      expect(client.closed).toBe(1);
      const persisted = await readMcpConfig();
      expect(persisted.servers[0]?.cachedTools).toEqual([PING]);
    });

    it('rolls back (writes nothing) and still closes the client when listTools fails', async () => {
      await writeMcpConfig({ servers: [{ kind: 'stdio', name: 'demo', command: 'noop' }] });
      const client = makeClient({
        listTools: async () => {
          throw new Error('list boom');
        },
      });
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(makeRegistry());
      await expect(rt.refreshServerCache(stored({ cachedTools: undefined }))).rejects.toThrow(/list boom/);
      // finally{} must have closed the client even though listTools threw.
      expect(client.closed).toBe(1);
      // No cache written — the on-disk entry is untouched.
      const persisted = await readMcpConfig();
      expect(persisted.servers[0]?.cachedTools).toBeUndefined();
    });
  });

  describe('detachServer', () => {
    it('unregisters tools, closes the client, and forgets the runtime', async () => {
      const registry = makeRegistry();
      const client = makeClient();
      hoisted.connectImpl = async () => client;
      const rt = createMcpRuntime(registry);
      await rt.attachServer({ kind: 'stdio', name: 'demo', command: 'x' });
      expect(await rt.detachServer('demo')).toBe(true);
      expect(registry.has('mcp__demo__ping')).toBe(false);
      expect(rt.runtimes.has('demo')).toBe(false);
      expect(client.closed).toBe(1);
    });

    it('returns false for an unknown server', async () => {
      const rt = createMcpRuntime(makeRegistry());
      expect(await rt.detachServer('ghost')).toBe(false);
    });
  });
});
