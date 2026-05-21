import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LLMProvider, ProviderEvent } from '@moxxy/sdk';
import { MemoryStore } from './store.js';
import { buildMemoryConsolidatePlugin } from './consolidate.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-nudge-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const stubProvider: LLMProvider = {
  name: 'stub',
  models: [],
  async *stream(): AsyncIterable<ProviderEvent> {},
  async countTokens() {
    return 0;
  },
};

const baseReq = (system?: string): import('@moxxy/sdk').ProviderRequest => ({
  model: 'stub',
  messages: [],
  ...(system !== undefined ? { system } : {}),
});

const ctx = (): import('@moxxy/sdk').TurnContext => ({
  sessionId: 's' as never,
  cwd: '/tmp',
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  env: {},
  turnId: 't' as never,
  iteration: 0,
});

async function fillMemories(store: MemoryStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.save({
      name: `entry-${i}`,
      type: 'fact',
      description: `Entry ${i}`,
      body: `body ${i}`,
    });
  }
}

describe('auto-consolidation nudge hook', () => {
  it('appends a hint to system prompt when memory count exceeds threshold', async () => {
    const store = new MemoryStore({ dir: tmp, embedder: null });
    await fillMemories(store, 5);
    const plugin = buildMemoryConsolidatePlugin(store, () => stubProvider, { autoNudgeThreshold: 3 });
    const result = await plugin.hooks?.onBeforeProviderCall?.(baseReq('be terse'), ctx());
    expect(result).toBeDefined();
    expect(result!.system).toContain('be terse');
    expect(result!.system).toContain('memory_consolidate');
    expect(result!.system).toContain('5 entries');
  });

  it('does NOT append a hint when memory count is below threshold', async () => {
    const store = new MemoryStore({ dir: tmp, embedder: null });
    await fillMemories(store, 2);
    const plugin = buildMemoryConsolidatePlugin(store, () => stubProvider, { autoNudgeThreshold: 10 });
    const result = await plugin.hooks?.onBeforeProviderCall?.(baseReq(), ctx());
    expect(result).toBeUndefined();
  });

  it('nudges at most once per session (no repeat fires)', async () => {
    const store = new MemoryStore({ dir: tmp, embedder: null });
    await fillMemories(store, 5);
    const plugin = buildMemoryConsolidatePlugin(store, () => stubProvider, { autoNudgeThreshold: 3 });
    const first = await plugin.hooks?.onBeforeProviderCall?.(baseReq(), ctx());
    const second = await plugin.hooks?.onBeforeProviderCall?.(baseReq(), ctx());
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it('threshold:0 disables the nudge entirely', async () => {
    const store = new MemoryStore({ dir: tmp, embedder: null });
    await fillMemories(store, 100);
    const plugin = buildMemoryConsolidatePlugin(store, () => stubProvider, { autoNudgeThreshold: 0 });
    // With threshold 0, no hooks are registered at all
    expect(plugin.hooks?.onBeforeProviderCall).toBeUndefined();
  });

  it('default threshold is 30', async () => {
    const store = new MemoryStore({ dir: tmp, embedder: null });
    await fillMemories(store, 30);
    const plugin = buildMemoryConsolidatePlugin(store, () => stubProvider);
    // 30 is not greater than 30 → no nudge
    const result = await plugin.hooks?.onBeforeProviderCall?.(baseReq(), ctx());
    expect(result).toBeUndefined();
  });

  it('declares the memory plugin as a hard requirement', () => {
    const store = new MemoryStore({ dir: tmp, embedder: null });
    const plugin = buildMemoryConsolidatePlugin(store, () => stubProvider);

    expect(plugin.requirements).toEqual([
      {
        kind: 'plugin',
        name: '@moxxy/plugin-memory',
        state: 'registered',
        hint: 'Enable @moxxy/plugin-memory.',
      },
    ]);
  });
});
