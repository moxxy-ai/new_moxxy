import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, McpToolDescriptor } from '../../types.js';
import { readMcpConfig, writeMcpConfig } from '../config-io.js';
import type { AddServerInput } from '../schema.js';
import type { AdminToolRegistryLike } from '../types.js';
import { buildAddServerTool, type AddServerToolDeps } from './add.js';

const PING: McpToolDescriptor = { name: 'ping', description: 'pong', inputSchema: { type: 'object' } };

const ctx = () => ({
  sessionId: 's' as never,
  turnId: 't' as never,
  callId: 'c' as never,
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

const stdioInput = (over: Partial<AddServerInput> = {}): AddServerInput =>
  ({ kind: 'stdio', name: 'demo', command: 'noop', autoSkill: true, ...over }) as AddServerInput;

const fakeRegistry = (): AdminToolRegistryLike => ({
  has: () => false,
  register: () => {},
  unregister: () => {},
});

describe('admin/tools/add (mcp_add_server)', () => {
  let home: string;
  const original = process.env.MOXXY_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moxxy-mcp-add-'));
    process.env.MOXXY_HOME = home;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.MOXXY_HOME;
    else process.env.MOXXY_HOME = original;
    await rm(home, { recursive: true, force: true });
  });

  const makeDeps = (over: Partial<AddServerToolDeps> = {}): {
    deps: AddServerToolDeps;
    attach: ReturnType<typeof vi.fn>;
    writeSkill: ReturnType<typeof vi.fn>;
  } => {
    const attach = vi.fn(async (_server: McpServerConfig) => ({
      toolNames: ['mcp__demo__ping'],
      descriptors: [PING] as ReadonlyArray<McpToolDescriptor>,
    }));
    const writeSkill = vi.fn(async (_s: McpServerConfig, _d: ReadonlyArray<McpToolDescriptor>) => ({
      path: join(home, 'skills', 'demo-mcp.md'),
      skillName: 'demo-mcp',
    }));
    const deps: AddServerToolDeps = {
      registry: fakeRegistry(),
      attachServer: attach as never,
      writeMcpUsageSkill: writeSkill as never,
      ...over,
    };
    return { deps, attach, writeSkill };
  };

  it('rejects a duplicate name before attaching anything', async () => {
    await writeMcpConfig({ servers: [{ kind: 'stdio', name: 'demo', command: 'x' }] });
    const { deps, attach } = makeDeps();
    const tool = buildAddServerTool(deps);
    await expect(tool.handler(stdioInput(), ctx())).rejects.toThrow(/already exists/);
    // Must short-circuit before paying the connection cost.
    expect(attach).not.toHaveBeenCalled();
    // Catalog unchanged.
    expect((await readMcpConfig()).servers).toHaveLength(1);
  });

  it('attaches + persists with cached descriptors + writes the usage skill on success', async () => {
    const { deps, attach, writeSkill } = makeDeps();
    const tool = buildAddServerTool(deps);
    const res = (await tool.handler(stdioInput(), ctx())) as {
      ok: boolean;
      attached: boolean;
      tools: string[];
      skill: { skillName: string } | null;
    };
    expect(res.ok).toBe(true);
    expect(res.attached).toBe(true);
    expect(res.tools).toEqual(['mcp__demo__ping']);
    expect(res.skill?.skillName).toBe('demo-mcp');
    expect(attach).toHaveBeenCalledTimes(1);
    expect(writeSkill).toHaveBeenCalledTimes(1);
    // Persisted entry caches the discovered descriptors for lazy boot.
    const cfg = await readMcpConfig();
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]).toMatchObject({ name: 'demo', command: 'noop', cachedTools: [PING] });
  });

  it('does NOT persist or write a skill when attach fails (no broken entry on disk)', async () => {
    const attach = vi.fn(async () => {
      throw new Error('connect failed');
    });
    const { deps, writeSkill } = makeDeps({ attachServer: attach as never });
    const tool = buildAddServerTool(deps);
    await expect(tool.handler(stdioInput(), ctx())).rejects.toThrow(/connect failed/);
    expect(writeSkill).not.toHaveBeenCalled();
    expect((await readMcpConfig()).servers).toEqual([]);
  });

  it('skips the usage skill when autoSkill is false', async () => {
    const { deps, writeSkill } = makeDeps();
    const tool = buildAddServerTool(deps);
    const res = (await tool.handler(stdioInput({ autoSkill: false }), ctx())) as { skill: unknown };
    expect(writeSkill).not.toHaveBeenCalled();
    expect(res.skill).toBeNull();
    // Server still attached + persisted.
    expect((await readMcpConfig()).servers).toHaveLength(1);
  });

  it('reports skillError but still succeeds when skill writing throws', async () => {
    const writeSkill = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { deps } = makeDeps({ writeMcpUsageSkill: writeSkill as never });
    const tool = buildAddServerTool(deps);
    const res = (await tool.handler(stdioInput(), ctx())) as {
      ok: boolean;
      skill: unknown;
      skillError?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.skill).toBeNull();
    expect(res.skillError).toMatch(/disk full/);
    // Attach + persist still succeeded despite the skill failure.
    expect((await readMcpConfig()).servers).toHaveLength(1);
  });

  it('reports attached:false (config-only) when no live registry is wired', async () => {
    const { deps } = makeDeps({ registry: null });
    const tool = buildAddServerTool(deps);
    const res = (await tool.handler(stdioInput(), ctx())) as { attached: boolean; note: string };
    expect(res.attached).toBe(false);
    expect(res.note).toMatch(/Restart moxxy/);
  });

  it('persists an http server with its url + headers', async () => {
    const { deps } = makeDeps();
    const tool = buildAddServerTool(deps);
    await tool.handler(
      stdioInput({ kind: 'http', name: 'remote', command: undefined, url: 'https://r.test', headers: { a: 'b' } }),
      ctx(),
    );
    const cfg = await readMcpConfig();
    expect(cfg.servers[0]).toMatchObject({
      kind: 'http',
      name: 'remote',
      url: 'https://r.test',
      headers: { a: 'b' },
      cachedTools: [PING],
    });
  });
});
