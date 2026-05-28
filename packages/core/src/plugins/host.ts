import type {
  AgentDef,
  CacheStrategyDef,
  ChannelDef,
  CommandDef,
  CompactorDef,
  ModeDef,
  MoxxyRequirement,
  Plugin,
  PluginHostHandle,
  ProviderDef,
  RequirementCheck,
  RequirementIssue,
  ResolvedPluginManifest,
  ToolDef,
  TranscriberDef,
  EmbedderDef,
  Isolator,
  ViewRendererDef,
  TunnelProviderDef,
  WorkflowExecutorDef,
} from '@moxxy/sdk';
import type { Logger } from '../logger.js';
import type { AgentRegistry } from '../registries/agents.js';
import type { CommandRegistry } from '../registries/commands.js';
import type { ChannelRegistryImpl } from '../registries/channels.js';
import type { CacheStrategyRegistry } from '../registries/cache-strategies.js';
import type { ViewRendererRegistry } from '../registries/view-renderers.js';
import type { TunnelProviderRegistry } from '../registries/tunnel-providers.js';
import type { CompactorRegistry } from '../registries/compactors.js';
import type { ModeRegistry } from '../registries/modes.js';
import type { ProviderRegistry } from '../registries/providers.js';
import type { ToolRegistry } from '../registries/tools.js';
import type { TranscriberRegistry } from '../registries/transcribers.js';
import type { EmbedderRegistry } from '../registries/embedders.js';
import type { IsolatorRegistry } from '../registries/isolators.js';
import type { WorkflowExecutorRegistry } from '../registries/workflow-executors.js';
import type { HookDispatcherImpl } from './lifecycle.js';
import type { RequirementRegistry } from '../requirements.js';
import { discoverPlugins } from './discovery.js';
import { toposortPluginManifests, PluginCycleError } from './toposort.js';

export interface PluginHostOptions {
  readonly cwd: string;
  readonly logger: Logger;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly modes: ModeRegistry;
  readonly compactors: CompactorRegistry;
  readonly cacheStrategies: CacheStrategyRegistry;
  readonly viewRenderers: ViewRendererRegistry;
  readonly tunnelProviders: TunnelProviderRegistry;
  readonly channels: ChannelRegistryImpl;
  readonly agents: AgentRegistry;
  readonly commands: CommandRegistry;
  readonly transcribers: TranscriberRegistry;
  readonly embedders: EmbedderRegistry;
  readonly isolators: IsolatorRegistry;
  readonly workflowExecutors: WorkflowExecutorRegistry;
  readonly requirements: RequirementRegistry;
  readonly dispatcher: HookDispatcherImpl;
  readonly loader?: PluginLoader;
  /**
   * Extra discovery roots beyond the cwd-rooted `node_modules` walk (e.g.
   * `~/.moxxy/plugins` and its `node_modules`). Stored so `reload()` reuses
   * them — otherwise a reload would compute its "wanted" set without these
   * paths and unload every user plugin, then fail to rediscover them.
   */
  readonly userPaths?: ReadonlyArray<string>;
}

export interface PluginLoader {
  load(manifest: ResolvedPluginManifest): Promise<Plugin>;
}

export interface RegisterStaticOptions {
  /**
   * Static requirements to enforce before registration. Mirrors the
   * `moxxy.requirements` field a discovered plugin's package.json would
   * carry; passed explicitly here because statically-imported builtins
   * don't go through `discoverPlugins()`.
   */
  readonly requirements?: ReadonlyArray<MoxxyRequirement>;
}

export type PluginSkipSource = 'static' | 'discovered';
export type PluginSkipReason = 'unmet_requirements' | 'load_error';

export interface PluginSkipRecord {
  readonly pluginName: string;
  readonly source: PluginSkipSource;
  readonly reason: PluginSkipReason;
  readonly message: string;
  readonly packageName?: string;
  readonly issues?: ReadonlyArray<RequirementIssue>;
  readonly hints: ReadonlyArray<string>;
}

export class PluginRequirementError extends Error {
  constructor(
    readonly pluginName: string,
    readonly check: RequirementCheck,
  ) {
    super(
      check.issues
        .filter((issue) => !issue.requirement.optional)
        .map((issue) => issue.message)
        .join('; '),
    );
    this.name = 'PluginRequirementError';
  }
}

interface LoadedRecord {
  readonly plugin: Plugin;
  readonly manifest?: ResolvedPluginManifest;
  readonly toolNames: ReadonlyArray<string>;
  readonly providerNames: ReadonlyArray<string>;
  readonly modeNames: ReadonlyArray<string>;
  readonly compactorNames: ReadonlyArray<string>;
  readonly cacheStrategyNames: ReadonlyArray<string>;
  readonly viewRendererNames: ReadonlyArray<string>;
  readonly tunnelProviderNames: ReadonlyArray<string>;
  readonly channelNames: ReadonlyArray<string>;
  readonly agentNames: ReadonlyArray<string>;
  readonly commandNames: ReadonlyArray<string>;
  readonly transcriberNames: ReadonlyArray<string>;
  readonly embedderNames: ReadonlyArray<string>;
  readonly isolatorNames: ReadonlyArray<string>;
  readonly workflowExecutorNames: ReadonlyArray<string>;
}

export class PluginHost implements PluginHostHandle {
  private readonly loaded = new Map<string, LoadedRecord>();
  private readonly skipped = new Map<string, PluginSkipRecord>();

  constructor(private readonly opts: PluginHostOptions) {}

  list(): ReadonlyArray<{ name: string; version: string; loaded: boolean }> {
    return [...this.loaded.values()].map((r) => ({
      name: r.plugin.name,
      version: r.plugin.version,
      loaded: true,
    }));
  }

  listSkipped(): ReadonlyArray<PluginSkipRecord> {
    return [...this.skipped.values()];
  }

  registerStatic(plugin: Plugin, opts: RegisterStaticOptions = {}): void {
    if (this.loaded.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }
    this.assertRequirementsReady(plugin, opts.requirements, 'static');
    const record = this.applyPlugin(plugin);
    this.loaded.set(plugin.name, record);
    this.clearSkip(plugin.name);
    this.opts.requirements.registerPlugin(plugin.name, plugin.version);
    this.refreshDispatcher();
  }

  registerDiscovered(plugin: Plugin, manifest: ResolvedPluginManifest): void {
    // Key the loaded map by the PACKAGE name — not the plugin's declared
    // `name` — so it lines up with `discoverAndLoad`'s dedupe check, `reload`'s
    // `wanted` set, and `unload(packageName)` callers (self-update, config,
    // plugins-admin). Keying by `plugin.name` silently broke all three whenever
    // a plugin's declared name differed from its package name (re-load throws,
    // reload unloads everything, unload no-ops).
    if (this.loaded.has(manifest.packageName)) {
      throw new Error(`Plugin already registered: ${manifest.packageName}`);
    }
    this.assertRequirementsReady(plugin, manifest.requirements, 'discovered', manifest);
    const record = this.applyPlugin(plugin, manifest);
    this.loaded.set(manifest.packageName, record);
    this.clearSkip(plugin.name);
    this.clearSkip(manifest.packageName);
    this.opts.requirements.registerPlugin(plugin.name, plugin.version);
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
    let ordered: ReadonlyArray<ResolvedPluginManifest>;
    try {
      ordered = toposortPluginManifests(manifests);
    } catch (err) {
      if (err instanceof PluginCycleError) {
        this.opts.logger.warn('PluginHost: requirement cycle, falling back to unsorted order', {
          cycle: err.cycle,
        });
        ordered = manifests;
      } else {
        throw err;
      }
    }
    for (const manifest of ordered) {
      if (this.loaded.has(manifest.packageName)) continue;
      try {
        const plugin = await loader.load(manifest);
        this.registerDiscovered(plugin, manifest);
        loaded.push(plugin);
      } catch (err) {
        if (err instanceof PluginRequirementError) {
          this.opts.logger.warn('PluginHost: skipped plugin due to unmet requirements', {
            package: manifest.packageName,
            plugin: err.pluginName,
            err: err.message,
          });
          continue;
        }
        this.recordLoadError(manifest.packageName, 'discovered', manifest.packageName, err);
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
    for (const modeName of record.modeNames) this.opts.modes.unregister(modeName);
    for (const compName of record.compactorNames) this.opts.compactors.unregister(compName);
    for (const csName of record.cacheStrategyNames) this.opts.cacheStrategies.unregister(csName);
    for (const vrName of record.viewRendererNames) this.opts.viewRenderers.unregister(vrName);
    for (const tpName of record.tunnelProviderNames) this.opts.tunnelProviders.unregister(tpName);
    for (const channelName of record.channelNames) this.opts.channels.unregister(channelName);
    for (const agentName of record.agentNames) this.opts.agents.unregister(agentName);
    for (const cmdName of record.commandNames) this.opts.commands.unregister(cmdName);
    for (const transcriberName of record.transcriberNames) this.opts.transcribers.unregister(transcriberName);
    for (const embedderName of record.embedderNames) this.opts.embedders.unregister(embedderName);
    for (const isolatorName of record.isolatorNames) this.opts.isolators.unregister(isolatorName);
    for (const wfxName of record.workflowExecutorNames)
      this.opts.workflowExecutors.unregister(wfxName);
    this.loaded.delete(name);
    this.opts.requirements.unregisterPlugin(record.plugin.name);
    this.refreshDispatcher();
  }

  async reload(): Promise<void> {
    this.opts.logger.info('PluginHost.reload(): rescanning plugins');
    // Reuse the same discovery roots the initial load used (incl. the user
    // plugin dirs) for BOTH the "wanted" scan and the re-load. Omitting them
    // would mark user plugins as not-wanted (→ unloaded) and never re-add them.
    const manifests = await discoverPlugins({
      cwd: this.opts.cwd,
      logger: this.opts.logger,
      ...(this.opts.userPaths ? { extraPaths: this.opts.userPaths } : {}),
    });
    const wanted = new Set(manifests.map((m) => m.packageName));
    for (const [name] of [...this.loaded]) {
      // Statically-registered builtins have no manifest; never unload them on
      // reload — they aren't discovered from disk so they'd never come back.
      if (this.loaded.get(name)?.manifest && !wanted.has(name)) await this.unload(name);
    }
    await this.discoverAndLoad(this.opts.userPaths);
  }

  private applyPlugin(plugin: Plugin, manifest?: ResolvedPluginManifest): LoadedRecord {
    const toolNames = (plugin.tools ?? []).map((t: ToolDef) => t.name);
    const providerNames = (plugin.providers ?? []).map((p: ProviderDef) => p.name);
    const modeNames = (plugin.modes ?? []).map((l: ModeDef) => l.name);
    const compactorNames = (plugin.compactors ?? []).map((c: CompactorDef) => c.name);
    const cacheStrategyNames = (plugin.cacheStrategies ?? []).map((c: CacheStrategyDef) => c.name);
    const viewRendererNames = (plugin.viewRenderers ?? []).map((v: ViewRendererDef) => v.name);
    const tunnelProviderNames = (plugin.tunnelProviders ?? []).map((t: TunnelProviderDef) => t.name);
    const channelNames = (plugin.channels ?? []).map((c: ChannelDef) => c.name);
    const agentNames = (plugin.agents ?? []).map((a: AgentDef) => a.name);
    const commandNames = (plugin.commands ?? []).map((c: CommandDef) => c.name);
    const transcriberNames = (plugin.transcribers ?? []).map((t: TranscriberDef) => t.name);
    const embedderNames = (plugin.embedders ?? []).map((e: EmbedderDef) => e.name);
    const isolatorNames = (plugin.isolators ?? []).map((i: Isolator) => i.name);
    const workflowExecutorNames = (plugin.workflowExecutors ?? []).map(
      (w: WorkflowExecutorDef) => w.name,
    );

    for (const tool of plugin.tools ?? []) this.opts.tools.register(tool);
    for (const provider of plugin.providers ?? []) this.opts.providers.register(provider);
    for (const loop of plugin.modes ?? []) this.opts.modes.register(loop);
    for (const compactor of plugin.compactors ?? []) this.opts.compactors.register(compactor);
    for (const cacheStrategy of plugin.cacheStrategies ?? [])
      this.opts.cacheStrategies.register(cacheStrategy);
    for (const viewRenderer of plugin.viewRenderers ?? [])
      this.opts.viewRenderers.replace(viewRenderer);
    for (const tunnelProvider of plugin.tunnelProviders ?? [])
      this.opts.tunnelProviders.replace(tunnelProvider);
    for (const channel of plugin.channels ?? []) this.opts.channels.register(channel);
    for (const agent of plugin.agents ?? []) this.opts.agents.register(agent);
    for (const cmd of plugin.commands ?? []) this.opts.commands.register(cmd);
    for (const transcriber of plugin.transcribers ?? []) this.opts.transcribers.register(transcriber);
    for (const embedder of plugin.embedders ?? []) this.opts.embedders.register(embedder);
    for (const isolator of plugin.isolators ?? []) this.opts.isolators.register(isolator);
    for (const wfx of plugin.workflowExecutors ?? [])
      this.opts.workflowExecutors.register(wfx);

    return {
      plugin,
      manifest,
      toolNames,
      providerNames,
      modeNames,
      compactorNames,
      cacheStrategyNames,
      viewRendererNames,
      tunnelProviderNames,
      channelNames,
      agentNames,
      commandNames,
      transcriberNames,
      embedderNames,
      isolatorNames,
      workflowExecutorNames,
    };
  }

  private assertRequirementsReady(
    plugin: Plugin,
    requirements: ReadonlyArray<MoxxyRequirement> | undefined,
    source: PluginSkipSource = 'static',
    manifest?: ResolvedPluginManifest,
  ): void {
    if (!requirements || requirements.length === 0) return;
    const check = this.opts.requirements.check(requirements);
    if (!check.ready) {
      this.recordRequirementSkip(plugin, source, manifest, check);
      throw new PluginRequirementError(plugin.name, check);
    }
  }

  private refreshDispatcher(): void {
    this.opts.dispatcher.setPlugins([...this.loaded.values()].map((r) => r.plugin));
  }

  private recordRequirementSkip(
    plugin: Plugin,
    source: PluginSkipSource,
    manifest: ResolvedPluginManifest | undefined,
    check: RequirementCheck,
  ): void {
    const blocking = check.issues.filter((issue) => !issue.requirement.optional);
    this.skipped.set(skipKey(plugin.name), {
      pluginName: plugin.name,
      source,
      reason: 'unmet_requirements',
      message: blocking.map((issue) => issue.message).join('; '),
      ...(manifest ? { packageName: manifest.packageName } : {}),
      issues: check.issues,
      hints: blocking.flatMap((issue) => issue.hint ? [issue.hint] : []),
    });
  }

  private recordLoadError(
    pluginName: string,
    source: PluginSkipSource,
    packageName: string | undefined,
    err: unknown,
  ): void {
    this.skipped.set(skipKey(pluginName), {
      pluginName,
      source,
      reason: 'load_error',
      message: err instanceof Error ? err.message : String(err),
      ...(packageName ? { packageName } : {}),
      hints: [],
    });
  }

  private clearSkip(pluginName: string): void {
    this.skipped.delete(skipKey(pluginName));
  }
}

function skipKey(pluginName: string): string {
  return pluginName;
}
