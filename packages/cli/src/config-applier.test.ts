import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Session, autoAllowResolver, silentLogger } from '@moxxy/core';
import { defineProvider, definePlugin, defineTool, z, type Plugin } from '@moxxy/sdk';
import { buildSessionConfigApplier } from './config-applier.js';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Create a temp project dir + a fake `node_modules/<pkgName>/package.json`
 * carrying the requested `moxxy.requirements`. Returned `cwd` is what
 * the test should pass to `new Session({ cwd })` so the applier's
 * package-resolution path finds the staged manifest.
 */
async function makeFakePackageWithRequirements(
  pkgName: string,
  requirements: ReadonlyArray<{ kind: string; name: string; hint?: string }>,
): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-config-applier-'));
  tempDirs.push(cwd);
  const nodeModulesDir = path.join(cwd, 'node_modules', ...pkgName.split('/'));
  await fs.mkdir(nodeModulesDir, { recursive: true });
  await fs.writeFile(
    path.join(nodeModulesDir, 'package.json'),
    JSON.stringify({
      name: pkgName,
      version: '0.0.0',
      moxxy: { requirements },
    }),
  );
  return cwd;
}

function makeSession(cwd = '/tmp'): Session {
  const session = new Session({
    cwd,
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  // Minimum wiring so modes/compactors exist for setActive() calls
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
      modes: [
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

function makeBuiltin_(name: string): { name: string; plugin: Plugin } {
  return { name, plugin: definePlugin({ name }) };
}

describe('buildSessionConfigApplier', () => {
  it('changes to `mode` are applied immediately', async () => {
    const session = makeSession();
    const apply = buildSessionConfigApplier(session, { mode: 'tool-use' });
    const r = await apply({ mode: 'plan-execute' });
    expect(r.applied).toContain('mode');
    expect(r.pending).not.toContain('mode');
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
    const cwd = await makeFakePackageWithRequirements('@test/needs-base', [
      { kind: 'plugin', name: '@test/missing-base', hint: 'Enable @test/missing-base.' },
    ]);
    const session = makeSession(cwd);
    const entry = makeBuiltin_('@test/needs-base');
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
    const cfg = { mode: 'tool-use', compactor: 'summarize-old-turns' };
    const apply = buildSessionConfigApplier(makeSession(), cfg);
    const r = await apply(cfg);
    expect(r.applied).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});
