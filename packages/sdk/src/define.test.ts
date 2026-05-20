import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCompactor,
  defineLoopStrategy,
  definePermission,
  definePlugin,
  defineProvider,
  defineSkill,
  defineTool,
  defineTranscriber,
} from './define.js';

describe('define* factories', () => {
  it('definePlugin freezes and stamps __moxxy + version', () => {
    const p = definePlugin({ name: 'p', tools: [] });
    expect(p.__moxxy).toBe('plugin');
    expect(p.version).toBe('0.0.0');
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('definePlugin preserves explicit version', () => {
    const p = definePlugin({ name: 'p', version: '1.2.3' });
    expect(p.version).toBe('1.2.3');
  });

  it('definePlugin defaults version when spec.version is explicitly undefined', () => {
    // Reproduces the spread-order bug: a spec with `version: undefined`
    // (e.g. produced by destructuring) must not erase the default.
    const spec = { name: 'p', version: undefined as string | undefined };
    const p = definePlugin(spec);
    expect(p.version).toBe('0.0.0');
  });

  it('defineTool round-trips typed input', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echoes',
      inputSchema: z.object({ msg: z.string() }),
      handler: (input) => input.msg.toUpperCase(),
    });
    expect(tool.name).toBe('echo');
    const out = await tool.handler({ msg: 'hi' }, {} as never);
    expect(out).toBe('HI');
  });

  it('defineProvider, defineLoopStrategy, defineCompactor, definePermission, defineSkill, defineTranscriber all freeze', () => {
    const items = [
      defineProvider({ name: 'p', models: [], createClient: () => ({}) as never }),
      defineLoopStrategy({ name: 'l', run: async function* () {} }),
      defineCompactor({ name: 'c', shouldCompact: () => false, compact: async () => ({}) as never }),
      definePermission({ action: 'allow' }),
      defineSkill({ frontmatter: { name: 'foo', description: 'd' }, body: '' }),
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe: async () => ({ text: '' }) }),
      }),
    ];
    for (const item of items) expect(Object.isFrozen(item)).toBe(true);
  });

  it('defineTranscriber preserves displayName + createClient identity', () => {
    const t = defineTranscriber({
      name: 'whisper-fake',
      displayName: 'Whisper (fake)',
      createClient: (cfg) => ({
        name: 'whisper-fake',
        transcribe: async () => ({ text: String(cfg.echo ?? '') }),
      }),
    });
    expect(t.name).toBe('whisper-fake');
    expect(t.displayName).toBe('Whisper (fake)');
    const client = t.createClient({ echo: 'hi' });
    expect(client.name).toBe('whisper-fake');
  });
});
