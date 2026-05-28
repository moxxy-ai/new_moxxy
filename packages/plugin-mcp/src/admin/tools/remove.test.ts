import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMcpConfig, writeMcpConfig } from '../config-io.js';
import { buildRemoveServerTool } from './remove.js';

const ctx = () => ({
  sessionId: 's' as never,
  turnId: 't' as never,
  callId: 'c' as never,
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

describe('admin/tools/remove (mcp_remove_server)', () => {
  let home: string;
  const original = process.env.MOXXY_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'moxxy-mcp-rm-'));
    process.env.MOXXY_HOME = home;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.MOXXY_HOME;
    else process.env.MOXXY_HOME = original;
    await rm(home, { recursive: true, force: true });
  });

  it('removes from config AND detaches from the live session', async () => {
    await writeMcpConfig({
      servers: [
        { kind: 'stdio', name: 'demo', command: 'x' },
        { kind: 'stdio', name: 'keep', command: 'y' },
      ],
    });
    const detach = vi.fn(async () => true);
    const tool = buildRemoveServerTool({ detachServer: detach });
    const res = (await tool.handler({ name: 'demo' }, ctx())) as {
      removed: boolean;
      persistedChange: boolean;
      detachedFromSession: boolean;
    };
    expect(res).toMatchObject({ removed: true, persistedChange: true, detachedFromSession: true });
    expect(detach).toHaveBeenCalledWith('demo');
    expect((await readMcpConfig()).servers.map((s) => s.name)).toEqual(['keep']);
  });

  it('reports removed:true when only the live session had it (config no-op)', async () => {
    await writeMcpConfig({ servers: [] });
    const detach = vi.fn(async () => true);
    const tool = buildRemoveServerTool({ detachServer: detach });
    const res = (await tool.handler({ name: 'ephemeral' }, ctx())) as {
      removed: boolean;
      persistedChange: boolean;
      detachedFromSession: boolean;
    };
    expect(res).toMatchObject({ removed: true, persistedChange: false, detachedFromSession: true });
  });

  it('reports removed:false when nothing matched in config or session', async () => {
    await writeMcpConfig({ servers: [{ kind: 'stdio', name: 'demo', command: 'x' }] });
    const detach = vi.fn(async () => false);
    const tool = buildRemoveServerTool({ detachServer: detach });
    const res = (await tool.handler({ name: 'ghost' }, ctx())) as { removed: boolean; note: string };
    expect(res.removed).toBe(false);
    expect(res.note).toMatch(/No MCP server named "ghost"/);
    // Existing entry untouched.
    expect((await readMcpConfig()).servers.map((s) => s.name)).toEqual(['demo']);
  });
});
