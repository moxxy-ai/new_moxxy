import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { Plugin, ResolvedPluginManifest } from '@moxxy/sdk';
import {
  defineCompactor,
  defineMode,
  definePlugin,
  defineProvider,
  defineTool,
  defineTranscriber,
} from '@moxxy/sdk';
import { silentLogger } from '../logger.js';
import { ToolRegistryImpl } from '../registries/tools.js';
import { ProviderRegistry } from '../registries/providers.js';
import { ModeRegistry } from '../registries/modes.js';
import { CompactorRegistry } from '../registries/compactors.js';
import { ChannelRegistryImpl } from '../registries/channels.js';
import { AgentRegistry } from '../registries/agents.js';
import { CommandRegistry } from '../registries/commands.js';
import { TranscriberRegistry } from '../registries/transcribers.js';
import { HookDispatcherImpl } from './lifecycle.js';
import { PluginHost } from './host.js';
import { RequirementRegistry } from '../requirements.js';

const makeHost = () => {
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
  const dispatcher = new HookDispatcherImpl({ logger: silentLogger });
  const host = new PluginHost({
    cwd: '/tmp',
    logger: silentLogger,
    tools,
    providers,
    modes,
    compactors,
    channels,
    agents,
    commands,
    transcribers,
    requirements,
    dispatcher,
  });
  return { host, tools, providers, modes, compactors, channels, agents, commands, transcribers, requirements, dispatcher };
};

describe('PluginHost', () => {
  it('registerStatic wires up tools, providers, modes, compactors', () => {
    const { host, tools, providers, modes, compactors } = makeHost();
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
    const strategy = defineMode({ name: 'fake-loop', run: async function* () {} });
    const compactor = defineCompactor({
      name: 'fake-compact',
      shouldCompact: () => false,
      compact: async () => ({ type: 'compaction', compactor: 'fake-compact', replacedRange: [0, 0], summary: '', tokensSaved: 0, sessionId: '' as never, turnId: '' as never, source: 'compactor' }),
    });
    const plugin = definePlugin({
      name: 'demo',
      tools: [tool],
      providers: [provider],
      modes: [strategy],
      compactors: [compactor],
    });

    host.registerStatic(plugin);
    expect(tools.has('echo')).toBe(true);
    expect(providers.list()).toHaveLength(1);
    expect(modes.list()).toHaveLength(1);
    expect(compactors.list()).toHaveLength(1);
    expect(host.list()).toEqual([{ name: 'demo', version: '0.0.0', loaded: true }]);
  });

  it('rejects double registration', () => {
    const { host } = makeHost();
    const p = definePlugin({ name: 'x' });
    host.registerStatic(p);
    expect(() => host.registerStatic(p)).toThrow(/already registered/);
  });

  it('rejects plugins whose required plugin is missing without partial registration', () => {
    const { host, tools } = makeHost();
    const plugin = definePlugin({
      name: 'needs-codex',
      tools: [
        defineTool({
          name: 'should-not-register',
          description: '',
          inputSchema: z.any(),
          handler: () => null,
        }),
      ],
    });

    expect(() =>
      host.registerStatic(plugin, {
        requirements: [{ kind: 'plugin', name: '@moxxy/plugin-provider-openai-codex' }],
      }),
    ).toThrow(/Required plugin is not registered: @moxxy\/plugin-provider-openai-codex/);
    expect(tools.has('should-not-register')).toBe(false);
    expect(host.list()).toEqual([]);
    expect(host.listSkipped()).toMatchObject([
      {
        pluginName: 'needs-codex',
        source: 'static',
        reason: 'unmet_requirements',
        message: 'Required plugin is not registered: @moxxy/plugin-provider-openai-codex',
      },
    ]);
  });

  it('keeps optional plugin requirements as diagnostics without skipping registration', () => {
    const { host, tools } = makeHost();
    host.registerStatic(
      definePlugin({
        name: 'optional-codex',
        tools: [
          defineTool({
            name: 'optional-tool',
            description: '',
            inputSchema: z.any(),
            handler: () => null,
          }),
        ],
      }),
      {
        requirements: [
          {
            kind: 'plugin',
            name: '@moxxy/plugin-provider-openai-codex',
            optional: true,
            hint: 'Enable Codex for richer behavior.',
          },
        ],
      },
    );

    expect(tools.has('optional-tool')).toBe(true);
    expect(host.listSkipped()).toEqual([]);
  });

  it('clears a previous skip once the same plugin registers successfully', () => {
    const { host } = makeHost();
    const plugin = definePlugin({ name: 'needs-codex' });
    const opts = {
      requirements: [{ kind: 'plugin' as const, name: '@moxxy/plugin-provider-openai-codex' }],
    };

    expect(() => host.registerStatic(plugin, opts)).toThrow(/Required plugin is not registered/);
    expect(host.listSkipped()).toHaveLength(1);

    host.registerStatic(definePlugin({ name: '@moxxy/plugin-provider-openai-codex' }));
    host.registerStatic(plugin, opts);

    expect(host.listSkipped()).toEqual([]);
  });

  it('records discovered plugin skips with discovered source metadata', () => {
    const { host } = makeHost();
    const plugin = definePlugin({ name: '@demo/discovered' });

    expect(() =>
      host.registerDiscovered(plugin, {
        entry: './dist/index.js',
        packageName: '@demo/discovered',
        packageVersion: '1.0.0',
        packagePath: '/tmp/discovered',
        requirements: [{ kind: 'plugin', name: '@demo/base' }],
      }),
    ).toThrow(/Required plugin is not registered/);

    expect(host.listSkipped()).toMatchObject([
      {
        pluginName: '@demo/discovered',
        source: 'discovered',
        packageName: '@demo/discovered',
      },
    ]);
  });

  it('allows plugin registration after required plugin is loaded', () => {
    const { host, tools } = makeHost();
    host.registerStatic(definePlugin({ name: '@moxxy/plugin-provider-openai-codex' }));
    host.registerStatic(
      definePlugin({
        name: 'needs-codex',
        tools: [
          defineTool({
            name: 'registers-after-requirements',
            description: '',
            inputSchema: z.any(),
            handler: () => null,
          }),
        ],
      }),
      {
        requirements: [{ kind: 'plugin', name: '@moxxy/plugin-provider-openai-codex' }],
      },
    );

    expect(tools.has('registers-after-requirements')).toBe(true);
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

  it('keys a discovered plugin by package name, so unload(packageName) works even when it differs from the declared name', async () => {
    const { host, tools } = makeHost();
    const tool = defineTool({
      name: 'dt',
      description: '',
      inputSchema: z.any(),
      handler: () => null,
    });
    // Declared plugin name intentionally differs from the package name.
    const plugin = definePlugin({ name: 'weird-internal-name', tools: [tool] });
    host.registerDiscovered(plugin, {
      entry: './dist/index.js',
      packageName: '@scope/pkg',
      packageVersion: '1.0.0',
      packagePath: '/tmp/pkg',
    });
    expect(tools.has('dt')).toBe(true);
    // Callers (self-update/config/plugins-admin) unload by PACKAGE name.
    await host.unload('@scope/pkg');
    expect(tools.has('dt')).toBe(false);
  });

  it('discoverAndLoad without loader warns and returns nothing', async () => {
    const { host } = makeHost();
    const warn = vi.spyOn(silentLogger, 'warn');
    const result = await host.discoverAndLoad();
    expect(result).toEqual([]);
    warn.mockRestore();
  });

  describe('reload with userPaths', () => {
    const tempDirs: string[] = [];
    afterEach(async () => {
      await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
    });

    const makeHostWithUserPaths = (userPaths: ReadonlyArray<string>) => {
      const base = makeHost();
      const loader = {
        load: async (m: ResolvedPluginManifest): Promise<Plugin> =>
          definePlugin({
            name: m.packageName,
            tools: [
              defineTool({
                name: `${m.packageName}_tool`,
                description: '',
                inputSchema: z.any(),
                handler: () => null,
              }),
            ],
          }),
      };
      const host = new PluginHost({
        cwd: '/tmp',
        logger: silentLogger,
        tools: base.tools,
        providers: base.providers,
        modes: base.modes,
        compactors: base.compactors,
        channels: base.channels,
        agents: base.agents,
        commands: base.commands,
        transcribers: base.transcribers,
        requirements: base.requirements,
        dispatcher: base.dispatcher,
        loader,
        userPaths,
      });
      return { host, tools: base.tools };
    };

    const writeUserPlugin = async (root: string, name: string): Promise<void> => {
      const dir = path.join(root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', moxxy: { plugin: { entry: './index.mjs' } } }),
        'utf8',
      );
    };

    it('preserves static builtins and (re)discovers user-path plugins', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-host-'));
      tempDirs.push(root);
      const { host, tools } = makeHostWithUserPaths([root]);

      // A statically-registered builtin has no manifest — it must survive reload.
      host.registerStatic(
        definePlugin({
          name: 'builtin',
          tools: [defineTool({ name: 'builtin_tool', description: '', inputSchema: z.any(), handler: () => null })],
        }),
      );
      await writeUserPlugin(root, 'userplug');

      await host.reload();
      expect(tools.has('builtin_tool')).toBe(true); // static preserved
      expect(tools.has('userplug_tool')).toBe(true); // user-path discovered

      // Remove the user plugin from disk → reload unloads it, keeps the builtin.
      await fs.rm(path.join(root, 'userplug'), { recursive: true, force: true });
      await host.reload();
      expect(tools.has('userplug_tool')).toBe(false);
      expect(tools.has('builtin_tool')).toBe(true);
    });
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
