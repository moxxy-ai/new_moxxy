import { describe, expect, it, vi } from 'vitest';
import type { McpClientLike, McpServerConfig } from '../../types.js';
import type { AddServerInput } from '../schema.js';

// mcp_test_server connects through `defaultClientFactory` (../../client.js).
// Inject a fake so the test never spawns a real subprocess / opens a socket.
const hoisted = vi.hoisted(() => ({
  impl: null as ((server: McpServerConfig) => Promise<McpClientLike>) | null,
}));

vi.mock('../../client.js', () => ({
  defaultClientFactory: async (server: McpServerConfig): Promise<McpClientLike> => {
    if (!hoisted.impl) throw new Error('impl not set');
    return hoisted.impl(server);
  },
}));

const { buildTestServerTool } = await import('./test.js');

const ctx = () => ({
  sessionId: 's' as never,
  turnId: 't' as never,
  callId: 'c' as never,
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

const input = (over: Partial<AddServerInput> = {}): AddServerInput =>
  ({ kind: 'stdio', name: 'demo', command: 'noop', autoSkill: true, ...over }) as AddServerInput;

describe('admin/tools/test (mcp_test_server)', () => {
  it('returns ok + the tool list when the connection succeeds, and closes the client', async () => {
    let closed = 0;
    hoisted.impl = async () => ({
      listTools: async () => ({
        tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object' } }],
      }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed++;
      },
    });
    const tool = buildTestServerTool();
    const res = (await tool.handler(input(), ctx())) as {
      ok: boolean;
      name: string;
      tools: Array<{ name: string; description?: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.name).toBe('demo');
    expect(res.tools).toEqual([{ name: 'mcp__demo__ping', description: 'pong' }]);
    expect(closed).toBe(1);
  });

  it('returns ok:false with the error message when the connection fails (no throw)', async () => {
    hoisted.impl = async () => {
      throw new Error('connect refused');
    };
    const tool = buildTestServerTool();
    const res = (await tool.handler(input(), ctx())) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connect refused/);
  });

  it('still closes the client when listTools throws after connecting', async () => {
    let closed = 0;
    hoisted.impl = async () => ({
      listTools: async () => {
        throw new Error('list boom');
      },
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed++;
      },
    });
    const tool = buildTestServerTool();
    const res = (await tool.handler(input(), ctx())) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/list boom/);
    expect(closed).toBe(1);
  });
});
