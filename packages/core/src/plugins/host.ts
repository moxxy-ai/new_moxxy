import type {
  AgentDef,
  ChannelDef,
  CommandDef,
  CompactorDef,
  LoopStrategyDef,
  Plugin,
  PluginHostHandle,
  ProviderDef,
  ResolvedPluginManifest,
  ToolDef,
} from '@moxxy/sdk';
import type { Logger } from '../logger.js';
import type { AgentRegistry } from '../registries/agents.js';
import type { CommandRegistry } from '../registries/commands.js';
import type { ChannelRegistryImpl } from '../registries/channels.js';
import type { CompactorRegistry } from '../registries/compactors.js';
import type { LoopRegistry } from '../registries/loops.js';
import type { ProviderRegistry } from '../registries/providers.js';
import type { ToolRegistry } from '../registries/tools.js';
import type { HookDispatcherImpl } from './lifecycle.js';
import { discoverPlugins } from './discovery.js';

export interface PluginHostOptions {
  readonly cwd: string;
  readonly logger: Logger;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly loops: LoopRegistry;
  readonly compactors: CompactorRegistry;
  readonly channels: ChannelRegistryImpl;
  readonly agents: AgentRegistry;
  readonly commands: CommandRegistry;
  readonly dispatcher: HookDispatcherImpl;
  readonly loader?: PluginLoader;
}

export interface PluginLoader {
  load(manifest: ResolvedPluginManifest): Promise<Plugin>;
}

interface LoadedRecord {
  readonly plugin: Plugin;
  readonly manifest?: ResolvedPluginManifest;
  readonly toolNames: ReadonlyArray<string>;
  readonly providerNames: ReadonlyArray<string>;
  readonly loopNames: ReadonlyArray<string>;
  readonly compactorNames: ReadonlyArray<string>;
  readonly channelNames: ReadonlyArray<string>;
  readonly agentNames: ReadonlyArray<string>;
  readonly commandNames: ReadonlyArray<string>;
}

export class PluginHost implements PluginHostHandle {
  private readonly loaded = new Map<string, LoadedRecord>();

  constructor(private readonly opts: PluginHostOptions) {}

  list(): ReadonlyArray<{ name: string; version: string; loaded: boolean }> {
    return [...this.loaded.values()].map((r) => ({
      name: r.plugin.name,
      version: r.plugin.version,
      loaded: true,
    }));
  }

  registerStatic(plugin: Plugin): void {
    if (this.loaded.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }
    const record = this.applyPlugin(plugin);
    this.loaded.set(plugin.name, record);
    this.refreshDispatcher();
  }

  async discoverAndLoad(extraPaths?: ReadonlyArray<string>): Promise<ReadonlyArray<Plugin>> {
    const manifests = await discoverPlugins({
      cwd: this.opts.cwd,
      logger: this.opts.logger,
      extraPaths,
    });
    const loaded: Plugin[] = [];
    const loader = this.opts.loader;
    if (!loader) {
      this.opts.logger.warn(
        'PluginHost.discoverAndLoad called without a loader; static plugins only. Provide a loader (e.g. jiti loader) to enable dynamic discovery.',
      );
      return loaded;
    }
    for (const manifest of manifests) {
      if (this.loaded.has(manifest.packageName)) continue;
      try {
        const plugin = await loader.load(manifest);
        const record = this.applyPlugin(plugin, manifest);
        this.loaded.set(plugin.name, record);
        loaded.push(plugin);
      } catch (err) {
        this.opts.logger.warn('PluginHost: failed to load plugin', {
          package: manifest.packageName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.refreshDispatcher();
    return loaded;
  }

  async unload(name: string): Promise<void> {
    const record = this.loaded.get(name);
    if (!record) return;
    for (const toolName of record.toolNames) this.opts.tools.unregister(toolName);
    for (const provName of record.providerNames) this.opts.providers.unregister(provName);
    for (const loopName of record.loopNames) this.opts.loops.unregister(loopName);
    for (const compName of record.compactorNames) this.opts.compactors.unregister(compName);
    for (const channelName of record.channelNames) this.opts.channels.unregister(channelName);
    for (const agentName of record.agentNames) this.opts.agents.unregister(agentName);
    for (const cmdName of record.commandNames) this.opts.commands.unregister(cmdName);
    this.loaded.delete(name);
    this.refreshDispatcher();
  }

  async reload(): Promise<void> {
    this.opts.logger.info('PluginHost.reload(): rescanning plugins');
    const manifests = await discoverPlugins({
      cwd: this.opts.cwd,
      logger: this.opts.logger,
    });
    const wanted = new Set(manifests.map((m) => m.packageName));
    for (const [name] of [...this.loaded]) {
      if (!wanted.has(name)) await this.unload(name);
    }
    await this.discoverAndLoad();
  }

  private applyPlugin(plugin: Plugin, manifest?: ResolvedPluginManifest): LoadedRecord {
    const toolNames = (plugin.tools ?? []).map((t: ToolDef) => t.name);
    const providerNames = (plugin.providers ?? []).map((p: ProviderDef) => p.name);
    const loopNames = (plugin.loopStrategies ?? []).map((l: LoopStrategyDef) => l.name);
    const compactorNames = (plugin.compactors ?? []).map((c: CompactorDef) => c.name);
    const channelNames = (plugin.channels ?? []).map((c: ChannelDef) => c.name);
    const agentNames = (plugin.agents ?? []).map((a: AgentDef) => a.name);
    const commandNames = (plugin.commands ?? []).map((c: CommandDef) => c.name);

    for (const tool of plugin.tools ?? []) this.opts.tools.register(tool);
    for (const provider of plugin.providers ?? []) this.opts.providers.register(provider);
    for (const loop of plugin.loopStrategies ?? []) this.opts.loops.register(loop);
    for (const compactor of plugin.compactors ?? []) this.opts.compactors.register(compactor);
    for (const channel of plugin.channels ?? []) this.opts.channels.register(channel);
    for (const agent of plugin.agents ?? []) this.opts.agents.register(agent);
    for (const cmd of plugin.commands ?? []) this.opts.commands.register(cmd);

    return {
      plugin,
      manifest,
      toolNames,
      providerNames,
      loopNames,
      compactorNames,
      channelNames,
      agentNames,
      commandNames,
    };
  }

  private refreshDispatcher(): void {
    this.opts.dispatcher.setPlugins([...this.loaded.values()].map((r) => r.plugin));
  }
}
