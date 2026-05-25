import { describe, expect, it } from 'vitest';
import { defineProvider, defineTranscriber } from '@moxxy/sdk';
import { RequirementRegistry } from './requirements.js';
import { ToolRegistryImpl } from './registries/tools.js';
import { ProviderRegistry } from './registries/providers.js';
import { ModeRegistry } from './registries/modes.js';
import { CompactorRegistry } from './registries/compactors.js';
import { ChannelRegistryImpl } from './registries/channels.js';
import { AgentRegistry } from './registries/agents.js';
import { CommandRegistry } from './registries/commands.js';
import { TranscriberRegistry } from './registries/transcribers.js';
import { silentLogger } from './logger.js';

const makeRequirements = () => {
  const tools = new ToolRegistryImpl({ logger: silentLogger, cwd: '/tmp' });
  const providers = new ProviderRegistry();
  const modes = new ModeRegistry();
  const compactors = new CompactorRegistry();
  const channels = new ChannelRegistryImpl();
  const agents = new AgentRegistry();
  const commands = new CommandRegistry();
  const transcribers = new TranscriberRegistry();
  const requirements = new RequirementRegistry({
    tools,
    providers,
    modes,
    compactors,
    channels,
    agents,
    commands,
    transcribers,
  });
  return { requirements, tools, providers, modes, compactors, transcribers };
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

  it('isReady checks a single named target without composing per-def requirements', () => {
    const { requirements, transcribers } = makeRequirements();
    transcribers.register(
      defineTranscriber({
        name: 'openai-codex-transcribe',
        createClient: () => ({ name: 'openai-codex-transcribe', transcribe: async () => ({ text: 'ok' }) }),
      }),
    );

    expect(requirements.isReady('transcriber', 'openai-codex-transcribe')).toMatchObject({
      ready: false,
      issues: [{ code: 'inactive' }],
    });

    transcribers.setActive('openai-codex-transcribe');

    expect(requirements.isReady('transcriber', 'openai-codex-transcribe')).toEqual({
      ready: true,
      issues: [],
    });
  });
});
