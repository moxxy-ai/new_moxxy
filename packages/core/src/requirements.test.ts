import { describe, expect, it, vi } from 'vitest';
import { defineCompactor, defineLoopStrategy, defineProvider, defineTool, defineTranscriber, z } from '@moxxy/sdk';
import { RequirementRegistry } from './requirements.js';
import { ToolRegistryImpl } from './registries/tools.js';
import { ProviderRegistry } from './registries/providers.js';
import { LoopRegistry } from './registries/loops.js';
import { CompactorRegistry } from './registries/compactors.js';
import { ChannelRegistryImpl } from './registries/channels.js';
import { AgentRegistry } from './registries/agents.js';
import { CommandRegistry } from './registries/commands.js';
import { TranscriberRegistry } from './registries/transcribers.js';
import { silentLogger } from './logger.js';

const makeRequirements = () => {
  const tools = new ToolRegistryImpl({ logger: silentLogger, cwd: '/tmp' });
  const providers = new ProviderRegistry();
  const loops = new LoopRegistry();
  const compactors = new CompactorRegistry();
  const channels = new ChannelRegistryImpl();
  const agents = new AgentRegistry();
  const commands = new CommandRegistry();
  const transcribers = new TranscriberRegistry();
  const requirements = new RequirementRegistry({
    tools,
    providers,
    loops,
    compactors,
    channels,
    agents,
    commands,
    transcribers,
  });
  return { requirements, tools, providers, loops, compactors, transcribers };
};

describe('RequirementRegistry', () => {
  it('reports missing registered requirements', () => {
    const { requirements } = makeRequirements();

    const check = requirements.check([{ kind: 'tool', name: 'web_fetch' }]);

    expect(check).toMatchObject({
      ready: false,
      issues: [{ code: 'missing', message: 'Required tool is not registered: web_fetch' }],
    });
  });

  it('reports inactive providers when active state is required', () => {
    const { requirements, providers } = makeRequirements();
    providers.register(
      defineProvider({
        name: 'openai-codex',
        models: [],
        createClient: () => ({ name: 'openai-codex', models: [], stream: async function* () {}, countTokens: async () => 0 }),
      }),
    );

    const check = requirements.check([{ kind: 'provider', name: 'openai-codex', state: 'active' }]);

    expect(check.ready).toBe(false);
    expect(check.issues[0]).toMatchObject({
      code: 'inactive',
      message: 'Required provider is not active: openai-codex',
    });
  });

  it('reports runtime requirements until they are marked ready', () => {
    const { requirements } = makeRequirements();
    const req = { kind: 'runtime' as const, name: 'auth:provider:openai-codex', state: 'ready' as const };

    expect(requirements.check([req])).toMatchObject({
      ready: false,
      issues: [{ code: 'not_ready' }],
    });

    requirements.setRuntime('auth:provider:openai-codex', 'ready');

    expect(requirements.check([req])).toEqual({ ready: true, issues: [] });
  });

  it('keeps optional requirements as diagnostics without blocking readiness', () => {
    const { requirements } = makeRequirements();

    const check = requirements.check([{ kind: 'runtime', name: 'browser:installed', state: 'ready', optional: true }]);

    expect(check.ready).toBe(true);
    expect(check.issues[0]).toMatchObject({ code: 'not_ready' });
  });

  it('checks requirements attached to a registered target', () => {
    const { requirements, providers, transcribers } = makeRequirements();
    providers.register(
      defineProvider({
        name: 'openai-codex',
        models: [],
        createClient: () => ({ name: 'openai-codex', models: [], stream: async function* () {}, countTokens: async () => 0 }),
      }),
    );
    transcribers.register(
      defineTranscriber({
        name: 'openai-codex-transcribe',
        requirements: [
          { kind: 'provider', name: 'openai-codex', state: 'active' },
          { kind: 'runtime', name: 'auth:provider:openai-codex', state: 'ready' },
        ],
        createClient: () => ({ name: 'openai-codex-transcribe', transcribe: async () => ({ text: 'ok' }) }),
      }),
    );

    expect(requirements.isReady('transcriber', 'openai-codex-transcribe')).toMatchObject({
      ready: false,
      issues: [{ code: 'inactive' }, { code: 'not_ready' }],
    });

    providers.setActive('openai-codex');
    requirements.setRuntime('auth:provider:openai-codex', 'ready');

    expect(requirements.isReady('transcriber', 'openai-codex-transcribe')).toEqual({
      ready: true,
      issues: [],
    });
  });

  it('checks directly registered runtime-independent blocks as ready', () => {
    const { requirements, tools } = makeRequirements();
    tools.register(defineTool({ name: 'echo', description: '', inputSchema: z.any(), handler: () => null }));

    expect(requirements.isReady('tool', 'echo')).toEqual({ ready: true, issues: [] });
  });

  it('blocks tool execution when tool requirements are not ready', async () => {
    const { requirements, tools } = makeRequirements();
    tools.setRequirementChecker(requirements);
    const handler = vi.fn(() => 'ok');
    tools.register(
      defineTool({
        name: 'needs-runtime',
        description: '',
        requirements: [{ kind: 'runtime', name: 'tool:ready', state: 'ready' }],
        inputSchema: z.object({}),
        handler,
      }),
    );

    await expect(
      tools.execute('needs-runtime', {}, new AbortController().signal),
    ).rejects.toThrow('Required runtime is not ready: tool:ready');
    expect(handler).not.toHaveBeenCalled();

    requirements.setRuntime('tool:ready', 'ready');
    await expect(tools.execute('needs-runtime', {}, new AbortController().signal)).resolves.toBe('ok');
  });

  it('blocks provider activation when provider requirements are not ready', () => {
    const { requirements, providers } = makeRequirements();
    providers.setRequirementChecker(requirements);
    providers.register(
      defineProvider({
        name: 'needs-runtime-provider',
        requirements: [{ kind: 'runtime', name: 'provider:ready', state: 'ready' }],
        models: [],
        createClient: () => ({ name: 'needs-runtime-provider', models: [], stream: async function* () {}, countTokens: async () => 0 }),
      }),
    );

    expect(() => providers.setActive('needs-runtime-provider')).toThrow(
      'Required runtime is not ready: provider:ready',
    );
    requirements.setRuntime('provider:ready', 'ready');
    expect(providers.setActive('needs-runtime-provider').name).toBe('needs-runtime-provider');
  });

  it('blocks loop and compactor activation when their requirements are not ready', () => {
    const { requirements, loops, compactors } = makeRequirements();
    loops.setRequirementChecker(requirements);
    compactors.setRequirementChecker(requirements);
    loops.register(defineLoopStrategy({ name: 'base-loop', run: async function* () {} }));
    loops.register(
      defineLoopStrategy({
        name: 'needs-runtime-loop',
        requirements: [{ kind: 'runtime', name: 'loop:ready', state: 'ready' }],
        run: async function* () {},
      }),
    );
    compactors.register(
      defineCompactor({
        name: 'base-compactor',
        shouldCompact: () => false,
        compact: async () => ({}) as never,
      }),
    );
    compactors.register(
      defineCompactor({
        name: 'needs-runtime-compactor',
        requirements: [{ kind: 'runtime', name: 'compactor:ready', state: 'ready' }],
        shouldCompact: () => false,
        compact: async () => ({}) as never,
      }),
    );

    expect(() => loops.setActive('needs-runtime-loop')).toThrow(
      'Required runtime is not ready: loop:ready',
    );
    expect(() => compactors.setActive('needs-runtime-compactor')).toThrow(
      'Required runtime is not ready: compactor:ready',
    );

    requirements.setRuntime('loop:ready', 'ready');
    requirements.setRuntime('compactor:ready', 'ready');
    expect(() => loops.setActive('needs-runtime-loop')).not.toThrow();
    expect(() => compactors.setActive('needs-runtime-compactor')).not.toThrow();
  });
});
