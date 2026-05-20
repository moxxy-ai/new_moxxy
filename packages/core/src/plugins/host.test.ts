import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineCompactor,
  defineLoopStrategy,
  definePlugin,
  defineProvider,
  defineTool,
  defineTranscriber,
} from '@moxxy/sdk';
import { silentLogger } from '../logger.js';
import { ToolRegistryImpl } from '../registries/tools.js';
import { ProviderRegistry } from '../registries/providers.js';
import { LoopRegistry } from '../registries/loops.js';
import { CompactorRegistry } from '../registries/compactors.js';
import { ChannelRegistryImpl } from '../registries/channels.js';
import { AgentRegistry } from '../registries/agents.js';
import { CommandRegistry } from '../registries/commands.js';
import { TranscriberRegistry } from '../registries/transcribers.js';
import { HookDispatcherImpl } from './lifecycle.js';
import { PluginHost } from './host.js';

const makeHost = () => {
  const tools = new ToolRegistryImpl({ logger: silentLogger, cwd: '/tmp' });
  const providers = new ProviderRegistry();
  const loops = new LoopRegistry();
  const compactors = new CompactorRegistry();
  const channels = new ChannelRegistryImpl();
  const agents = new AgentRegistry();
  const commands = new CommandRegistry();
  const transcribers = new TranscriberRegistry();
  const dispatcher = new HookDispatcherImpl({ logger: silentLogger });
  const host = new PluginHost({
    cwd: '/tmp',
    logger: silentLogger,
    tools,
    providers,
    loops,
    compactors,
    channels,
    agents,
    commands,
    transcribers,
    dispatcher,
  });
  return { host, tools, providers, loops, compactors, channels, agents, commands, transcribers, dispatcher };
};

describe('PluginHost', () => {
  it('registerStatic wires up tools, providers, loops, compactors', () => {
    const { host, tools, providers, loops, compactors } = makeHost();
    const tool = defineTool({
      name: 'echo',
      description: '',
      inputSchema: z.any(),
      handler: () => null,
    });
    const provider = defineProvider({
      name: 'fake',
      models: [],
      createClient: () => ({ name: 'fake', models: [], stream: async function* () {}, countTokens: async () => 0 }),
    });
    const strategy = defineLoopStrategy({ name: 'fake-loop', run: async function* () {} });
    const compactor = defineCompactor({
      name: 'fake-compact',
      shouldCompact: () => false,
      compact: async () => ({ type: 'compaction', compactor: 'fake-compact', replacedRange: [0, 0], summary: '', tokensSaved: 0, sessionId: '' as never, turnId: '' as never, source: 'compactor' }),
    });
    const plugin = definePlugin({
      name: 'demo',
      tools: [tool],
      providers: [provider],
      loopStrategies: [strategy],
      compactors: [compactor],
    });

    host.registerStatic(plugin);
    expect(tools.has('echo')).toBe(true);
    expect(providers.list()).toHaveLength(1);
    expect(loops.list()).toHaveLength(1);
    expect(compactors.list()).toHaveLength(1);
    expect(host.list()).toEqual([{ name: 'demo', version: '0.0.0', loaded: true }]);
  });

  it('rejects double registration', () => {
    const { host } = makeHost();
    const p = definePlugin({ name: 'x' });
    host.registerStatic(p);
    expect(() => host.registerStatic(p)).toThrow(/already registered/);
  });

  it('unload removes contributions', async () => {
    const { host, tools } = makeHost();
    const tool = defineTool({
      name: 'e',
      description: '',
      inputSchema: z.any(),
      handler: () => null,
    });
    const plugin = definePlugin({ name: 'demo', tools: [tool] });
    host.registerStatic(plugin);
    expect(tools.has('e')).toBe(true);
    await host.unload('demo');
    expect(tools.has('e')).toBe(false);
  });

  it('discoverAndLoad without loader warns and returns nothing', async () => {
    const { host } = makeHost();
    const warn = vi.spyOn(silentLogger, 'warn');
    const result = await host.discoverAndLoad();
    expect(result).toEqual([]);
    warn.mockRestore();
  });

  it('registerStatic + unload roundtrip transcribers', async () => {
    const { host, transcribers } = makeHost();
    const t = defineTranscriber({
      name: 'fake-stt',
      createClient: () => ({ name: 'fake-stt', transcribe: async () => ({ text: '' }) }),
    });
    host.registerStatic(definePlugin({ name: 'stt-demo', transcribers: [t] }));
    expect(transcribers.has('fake-stt')).toBe(true);
    expect(transcribers.list()).toHaveLength(1);

    await host.unload('stt-demo');
    expect(transcribers.has('fake-stt')).toBe(false);
  });
});
