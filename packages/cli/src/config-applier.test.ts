import { describe, expect, it } from 'vitest';
import { Session, autoAllowResolver, silentLogger } from '@moxxy/core';
import { defineProvider, definePlugin, defineTool, z, type Plugin } from '@moxxy/sdk';
import { buildSessionConfigApplier } from './config-applier.js';

function makeSession(): Session {
  const session = new Session({
    cwd: '/tmp',
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  // Minimum wiring so loops/compactors exist for setActive() calls
  session.pluginHost.registerStatic(
    definePlugin({
      name: '@moxxy/test-bootstrap',
      providers: [
        defineProvider({
          name: 'test',
          models: [{ id: 't1', contextWindow: 1, maxOutputTokens: 1, supportsTools: false, supportsStreaming: false }],
          createClient: () => ({ name: 'test', models: [], stream: async function* () {}, countTokens: async () => 0 }),
        }),
      ],
      loopStrategies: [
        { name: 'tool-use', run: async function* () {} },
        { name: 'plan-execute', run: async function* () {} },
      ],
    }),
  );
  return session;
}

function makeBuiltin(name: string): { name: string; plugin: Plugin } {
  return {
    name,
    plugin: definePlugin({
      name,
      tools: [
        defineTool({
          name: `${name}_tool`,
          description: name,
          inputSchema: z.object({}),
          handler: () => null,
        }),
      ],
    }),
  };
}

function makeBuiltinWithRequirement(name: string): { name: string; plugin: Plugin } {
  return {
    name,
    plugin: definePlugin({
      name,
      requirements: [{ kind: 'plugin', name: '@test/missing-base', hint: 'Enable @test/missing-base.' }],
    }),
  };
}

describe('buildSessionConfigApplier', () => {
  it('changes to `loop` are applied immediately', async () => {
    const session = makeSession();
    const apply = buildSessionConfigApplier(session, { loop: 'tool-use' });
    const r = await apply({ loop: 'plan-execute' });
    expect(r.applied).toContain('loop');
    expect(r.pending).not.toContain('loop');
  });

  it('changes to `compactor` are applied when the compactor is registered', async () => {
    const session = makeSession();
    session.compactors.register({
      name: 'fake-compact',
      shouldCompact: () => false,
      compact: async () => ({}) as never,
    });
    const apply = buildSessionConfigApplier(session, {});
    const r = await apply({ compactor: 'fake-compact' });
    expect(r.applied).toContain('compactor');
  });

  it('compactor set to a missing strategy reports pending with the error', async () => {
    const session = makeSession();
    const apply = buildSessionConfigApplier(session, {});
    const r = await apply({ compactor: 'nonexistent' });
    expect(r.applied).not.toContain('compactor');
    expect(r.pending.some((p) => p.startsWith('compactor'))).toBe(true);
  });

  it('provider.* changes are reported as pending', async () => {
    const apply = buildSessionConfigApplier(makeSession(), {
      provider: { name: 'anthropic', model: 'sonnet' },
    });
    const r = await apply({ provider: { name: 'anthropic', model: 'haiku' } });
    expect(r.pending.some((p) => p.startsWith('provider'))).toBe(true);
  });

  it('disabling a registered plugin unloads it', async () => {
    const session = makeSession();
    const entry = makeBuiltin('@test/plugin-x');
    session.pluginHost.registerStatic(entry.plugin);

    const apply = buildSessionConfigApplier(session, {}, [entry]);
    const r = await apply({ plugins: { '@test/plugin-x': { enabled: false } } });

    expect(r.applied).toContain('plugins[@test/plugin-x].enabled=false');
    expect(session.pluginHost.list().some((p) => p.name === '@test/plugin-x')).toBe(false);
  });

  it('re-enabling a previously-disabled plugin registers it again', async () => {
    const session = makeSession();
    const entry = makeBuiltin('@test/plugin-x');
    // Initial state: disabled (not in plugin host).
    const apply = buildSessionConfigApplier(
      session,
      { plugins: { '@test/plugin-x': { enabled: false } } },
      [entry],
    );
    const r = await apply({ plugins: { '@test/plugin-x': { enabled: true } } });

    expect(r.applied).toContain('plugins[@test/plugin-x].enabled=true');
    expect(session.pluginHost.list().some((p) => p.name === '@test/plugin-x')).toBe(true);
  });

  it('reports plugin enablement as pending when requirements are missing', async () => {
    const session = makeSession();
    const entry = makeBuiltinWithRequirement('@test/needs-base');
    const apply = buildSessionConfigApplier(
      session,
      { plugins: { '@test/needs-base': { enabled: false } } },
      [entry],
    );

    const r = await apply({ plugins: { '@test/needs-base': { enabled: true } } });

    expect(r.applied).not.toContain('plugins[@test/needs-base].enabled=true');
    expect(r.pending).toContain(
      'plugins[@test/needs-base].enabled=true (Required plugin is not registered: @test/missing-base)',
    );
  });

  it('toggle is a no-op when the plugin has no builtin entry registered with the applier', async () => {
    const session = makeSession();
    const apply = buildSessionConfigApplier(session, {}, []);
    const r = await apply({ plugins: { '@unknown/plug': { enabled: true } } });
    // No-op: the applier doesn't have a plugin handle, can't register
    expect(r.applied.find((a) => a.includes('@unknown/plug'))).toBeUndefined();
  });

  it('embeddings.* changes are reported as pending', async () => {
    const apply = buildSessionConfigApplier(makeSession(), { embeddings: { provider: 'tfidf' } });
    const r = await apply({ embeddings: { provider: 'openai' } });
    expect(r.pending.some((p) => p.startsWith('embeddings'))).toBe(true);
  });

  it('an unchanged config produces empty applied + pending lists', async () => {
    const cfg = { loop: 'tool-use', compactor: 'summarize-old-turns' };
    const apply = buildSessionConfigApplier(makeSession(), cfg);
    const r = await apply(cfg);
    expect(r.applied).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});
