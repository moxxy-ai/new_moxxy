import type {
  AppContext,
  ClientSession,
  LifecycleHooks,
  MoxxyEvent,
  RunTurnOptions,
  SessionId,
  SessionInfo,
} from '@moxxy/sdk';
import { newSessionId, newTurnId } from './events/factory.js';
import { runTurn as runTurnImpl } from './run-turn.js';
import type { SessionRuntime } from './session-runtime.js';
import { EventLog } from './events/log.js';
import { HookDispatcherImpl } from './plugins/lifecycle.js';
import { PluginHost, type PluginLoader } from './plugins/host.js';
import { ProviderRegistry } from './registries/providers.js';
import { ModeRegistry } from './registries/modes.js';
import { CacheStrategyRegistry } from './registries/cache-strategies.js';
import { ViewRendererRegistry } from './registries/view-renderers.js';
import { defaultViewRenderer } from './view/default-renderer.js';
import { TunnelProviderRegistry } from './registries/tunnel-providers.js';
import { localhostTunnel } from './tunnel/localhost.js';
import { CompactorRegistry } from './registries/compactors.js';
import { ChannelRegistryImpl } from './registries/channels.js';
import { SkillRegistryImpl } from './registries/skills.js';
import { ToolRegistryImpl, type ToolRegistry } from './registries/tools.js';
import { AgentRegistry } from './registries/agents.js';
import { CommandRegistry } from './registries/commands.js';
import { TranscriberRegistry } from './registries/transcribers.js';
import { EmbedderRegistry } from './registries/embedders.js';
import { IsolatorRegistry } from './registries/isolators.js';
import { WorkflowExecutorRegistry } from './registries/workflow-executors.js';
import { RequirementRegistry } from './requirements.js';
import { PermissionEngine } from './permissions/engine.js';
import { autoAllowResolver } from './permissions/resolvers.js';
import { evaluateToolRule } from '@moxxy/sdk';
import type {
  ApprovalResolver,
  CredentialResolver,
  ElisionSettings,
  McpAdminView,
  WorkflowsView,
  PendingToolCall,
  PermissionContext,
  PermissionResolver,
  PermissionRule,
} from '@moxxy/sdk';
import { createLogger, silentLogger, type Logger } from './logger.js';

export interface SessionOptions {
  readonly cwd: string;
  readonly logger?: Logger;
  readonly sessionId?: SessionId;
  readonly permissionEngine?: PermissionEngine;
  readonly permissionResolver?: PermissionResolver;
  readonly hookTimeoutMs?: number;
  readonly silent?: boolean;
  /**
   * Optional plugin loader. When provided, `session.pluginHost.discoverAndLoad()`
   * can dynamic-import discovered plugins; without one, only static plugins
   * registered via `registerStatic()` are wired up.
   */
  readonly pluginLoader?: PluginLoader;
  /**
   * Extra directories to scan for plugins, on top of the cwd-rooted
   * `node_modules` walk. The CLI sets this to `~/.moxxy/plugins` (and its
   * `node_modules` subtree) so runtime-installed / scaffolded plugins are
   * discoverable. Crucially these are remembered by the host and reused on
   * `pluginHost.reload()`, so a hot-reload neither drops user plugins nor
   * fails to pick up freshly written ones.
   */
  readonly pluginDiscoveryPaths?: ReadonlyArray<string>;
  /**
   * Pre-seeded event log. Used by `moxxy resume` to restore the
   * conversation from a persisted JSONL. Subscribers don't re-fire for
   * seeded events (the constructor pushes them directly), so plugin
   * hooks won't run for historical entries.
   */
  readonly log?: EventLog;
}

export class Session implements ClientSession, SessionRuntime {
  readonly id: SessionId;
  readonly cwd: string;
  readonly log: EventLog;
  readonly logger: Logger;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly modes: ModeRegistry;
  readonly compactors: CompactorRegistry;
  readonly cacheStrategies: CacheStrategyRegistry;
  readonly viewRenderers: ViewRendererRegistry;
  readonly tunnelProviders: TunnelProviderRegistry;
  readonly channels: ChannelRegistryImpl;
  readonly skills: SkillRegistryImpl;
  readonly agents: AgentRegistry;
  readonly commands: CommandRegistry;
  readonly transcribers: TranscriberRegistry;
  readonly embedders: EmbedderRegistry;
  readonly isolators: IsolatorRegistry;
  readonly workflowExecutors: WorkflowExecutorRegistry;
  readonly requirements: RequirementRegistry;
  readonly permissions: PermissionEngine;
  /** Current PermissionResolver. Update via `setPermissionResolver(r)`. */
  resolver: PermissionResolver;
  /**
   * Optional generic approval resolver. Loop strategies use this to ask
   * the user a checkpoint question (plan validation, command preview,
   * diff review, etc.). Null when running headless or before the TUI
   * registers one — strategies that have no resolver simply skip the
   * approval step.
   */
  approvalResolver: ApprovalResolver | null = null;
  /**
   * Elision (context-on-demand) settings, resolved from `config.context.elision`
   * at setup and updated on config reload. Null → built-in defaults apply
   * (elision on). Read into each turn's ModeContext.
   */
  elisionSettings: ElisionSettings | null = null;
  /** Lazy tool loading toggle, from `config.context.lazyTools`. Default off. */
  lazyTools = false;
  /**
   * Live runtime capabilities the host installs on a local Session (see
   * SessionLike). A RemoteSession leaves them undefined. Declared here — rather
   * than monkey-patched on via `as unknown as` — so the host and channels get
   * type-checked access.
   */
  readyProviders?: Set<string>;
  credentialResolver?: CredentialResolver;
  mcpAdmin?: McpAdminView;
  workflows?: WorkflowsView;
  readonly dispatcher: HookDispatcherImpl;
  readonly pluginHost: PluginHost;
  private readonly controller = new AbortController();

  constructor(opts: SessionOptions) {
    this.id = opts.sessionId ?? newSessionId();
    this.cwd = opts.cwd;
    this.logger = opts.logger ?? (opts.silent ? silentLogger : createLogger());
    this.log = opts.log ?? new EventLog();
    this.tools = new ToolRegistryImpl({ logger: this.logger, cwd: this.cwd });
    this.providers = new ProviderRegistry();
    this.modes = new ModeRegistry();
    this.compactors = new CompactorRegistry();
    this.cacheStrategies = new CacheStrategyRegistry();
    this.viewRenderers = new ViewRendererRegistry();
    // Seed the built-in renderer so `present_view` always has one to parse
    // with; plugins can register/replace and `setActive` an alternative.
    this.viewRenderers.register(defaultViewRenderer);
    this.tunnelProviders = new TunnelProviderRegistry();
    // Seed the no-op localhost provider so the web surface always resolves a
    // URL; plugins (cloudflared) register/setActive a real tunnel.
    this.tunnelProviders.register(localhostTunnel);
    this.channels = new ChannelRegistryImpl();
    this.skills = new SkillRegistryImpl();
    this.agents = new AgentRegistry();
    this.commands = new CommandRegistry();
    this.transcribers = new TranscriberRegistry();
    this.embedders = new EmbedderRegistry();
    this.isolators = new IsolatorRegistry();
    this.workflowExecutors = new WorkflowExecutorRegistry();
    this.requirements = new RequirementRegistry({
      tools: this.tools,
      providers: this.providers,
      modes: this.modes,
      compactors: this.compactors,
      channels: this.channels,
      agents: this.agents,
      commands: this.commands,
      transcribers: this.transcribers,
    });
    this.permissions = opts.permissionEngine ?? new PermissionEngine();
    // Always wrap the user-supplied resolver with the persistent
    // policy engine, so saved `allow_always` / `deny` rules from
    // ~/.moxxy/permissions.json short-circuit the resolver's prompt
    // path. Without this wrap the engine is dead weight — the
    // permissions JSON updates on every "allow always" click but no
    // future turn ever consults it.
    this.resolver = wrapWithPolicy(
      opts.permissionResolver ?? autoAllowResolver,
      this.permissions,
      (name) => this.tools.get(name)?.permission,
    );
    this.dispatcher = new HookDispatcherImpl({
      logger: this.logger,
      hookTimeoutMs: opts.hookTimeoutMs,
    });
    this.pluginHost = new PluginHost({
      cwd: this.cwd,
      logger: this.logger,
      tools: this.tools,
      providers: this.providers,
      modes: this.modes,
      compactors: this.compactors,
      cacheStrategies: this.cacheStrategies,
      viewRenderers: this.viewRenderers,
      tunnelProviders: this.tunnelProviders,
      channels: this.channels,
      agents: this.agents,
      commands: this.commands,
      transcribers: this.transcribers,
      embedders: this.embedders,
      isolators: this.isolators,
      workflowExecutors: this.workflowExecutors,
      requirements: this.requirements,
      dispatcher: this.dispatcher,
      loader: opts.pluginLoader,
      ...(opts.pluginDiscoveryPaths ? { userPaths: opts.pluginDiscoveryPaths } : {}),
    });

    // Fan every appended event out to plugin `onEvent` hooks. Without this
    // wiring the hook is dead code — declared on the SDK, dispatched by
    // HookDispatcherImpl, but nothing ever calls dispatchEvent.
    this.log.subscribe((event) => this.dispatcher.dispatchEvent(event, this.appContext()));
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason = 'user-requested abort'): void {
    this.controller.abort(reason);
  }

  /**
   * Swap the active PermissionResolver. Channels call this after they're
   * constructed so the session uses the channel's interactive resolver
   * (TUI prompt, Telegram inline keyboard, HTTP allow-list, etc.).
   * Replaces the previous monkey-patching of the private `resolver` field
   * from CLI command code.
   */
  setPermissionResolver(resolver: PermissionResolver): void {
    // Re-wrap so policy rules continue to short-circuit prompts when a
    // channel installs its own resolver mid-session.
    this.resolver = wrapWithPolicy(
      resolver,
      this.permissions,
      (name) => this.tools.get(name)?.permission,
    );
  }

  /** Install/replace the generic approval resolver. Pass null to clear. */
  setApprovalResolver(resolver: ApprovalResolver | null): void {
    this.approvalResolver = resolver;
  }

  /**
   * Graceful shutdown: fire every plugin's `onShutdown` hook, then abort
   * the session. Idempotent — safe to call multiple times (subsequent
   * calls are no-ops once `closed` is set).
   *
   * Channels' SIGINT handlers should call this before exiting so plugins
   * can flush state (memory journal, vault, audit logs, etc.).
   */
  async close(reason = 'shutdown'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.dispatcher.dispatchShutdown(this.appContext());
    } finally {
      this.abort(reason);
    }
  }

  private closed = false;

  appContext(): AppContext {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      log: this.log.asReader(),
      env: { ...process.env },
    };
  }

  startTurn(): { turnId: ReturnType<typeof newTurnId> } {
    return { turnId: newTurnId() };
  }

  subscribe(fn: (e: MoxxyEvent) => void | Promise<void>): () => void {
    return this.log.subscribe(fn);
  }

  /**
   * Drive one turn against this session. Method form of the `runTurn` free
   * function so a local `Session` satisfies `SessionLike` (the channel-facing
   * contract a `RemoteSession` proxy also implements).
   */
  runTurn(prompt: string, opts: RunTurnOptions = {}): AsyncIterable<MoxxyEvent> {
    return runTurnImpl(this, prompt, opts);
  }

  /**
   * Wire-friendly snapshot of the registries for channels to render. Mirrors
   * what a `RemoteSession` fetches from the runner over RPC - keep the two in
   * sync.
   */
  getInfo(): SessionInfo {
    let activeMode: string | null = null;
    try {
      activeMode = this.modes.getActive().name;
    } catch {
      // No mode active yet (registry empty pre-boot) - report null.
    }
    const active = this.providers.getActiveName();
    const ready = this.readyProviders;
    return {
      sessionId: this.id,
      cwd: this.cwd,
      activeProvider: active,
      providers: this.providers.list().map((p) => ({
        name: p.name,
        models: p.models,
        authKind: p.auth?.kind === 'oauth' ? 'oauth' : 'api-key',
        // Built-in providers ship hard-coded model lists, so live
        // discovery on /v1/models isn't required from the host. Admin-
        // registered providers (kind: 'apiKey' without a builtin def)
        // are the ones the desktop's "Fetch live" affordance targets;
        // they advertise this via the provider-admin factory by
        // setting `supportsLiveModelDiscovery: true` on their def.
        supportsLiveModelDiscovery:
          (p as { supportsLiveModelDiscovery?: boolean }).supportsLiveModelDiscovery === true,
      })),
      activeMode,
      modes: this.modes.list().map((m) => m.name),
      tools: this.tools.list().map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.compact ? { compact: t.compact } : {}),
      })),
      skills: this.skills.list().map((s) => ({ id: s.id, name: s.frontmatter.name })),
      commands: this.commands.list().map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.aliases ? { aliases: c.aliases } : {}),
        ...(c.channels ? { channels: c.channels } : {}),
        ...(c.pendingNotice ? { pendingNotice: c.pendingNotice } : {}),
      })),
      readyProviders: ready ? [...ready] : active ? [active] : [],
      // hasTranscriber reports whether any backend is *registered*,
      // not whether one is active. The active selection is per-flow
      // (the TUI activates Codex on its first voice toggle; the
      // desktop relies on handleTranscribe's candidate fallback).
      // For UI affordance gating (showing / hiding a mic button),
      // any registered transcriber means "voice is wired."
      hasTranscriber: this.transcribers.list().length > 0,
      activeTranscriber: this.transcribers.getActiveName(),
    };
  }

  registerHookOptions(_hooks: LifecycleHooks): void {
    // For tests: allows attaching a one-off hook bundle through a synthetic plugin if needed.
    // Implementation-detail helper, intentionally minimal.
  }
}

/**
 * Wrap a `PermissionResolver` so the persistent `PermissionEngine` runs
 * first. If the engine has a matching allow/deny rule from
 * `~/.moxxy/permissions.json`, that decision short-circuits the
 * resolver's prompt path. Otherwise the resolver runs as usual.
 *
 * The wrapper preserves the original resolver's identity for
 * `instanceof`-style checks (e.g. `abortAll` on the deferred resolver)
 * by re-exposing every property via Proxy — wait, simpler: we proxy
 * just `check`. Callers that need the underlying resolver's methods
 * still reach them via the prototype chain we copy in.
 */
function wrapWithPolicy(
  inner: PermissionResolver,
  engine: PermissionEngine,
  getToolRule: (name: string) => PermissionRule | undefined,
): PermissionResolver {
  // Use a Proxy so any extra methods on the underlying resolver
  // (`abortAll`, channel-specific helpers) remain accessible — only
  // `check` is intercepted.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'check') {
        return async (call: PendingToolCall, ctx: PermissionContext) => {
          // Precedence: user policy (permissions.json) wins, then the
          // tool's own declared rule (so a tool marked `allow` is never
          // blocked in headless runs), then the channel resolver's
          // prompt / deny-by-default path.
          const policy = engine.check(call);
          if (policy) return policy;
          const toolDecision = evaluateToolRule(getToolRule(call.name), call);
          if (toolDecision) return toolDecision;
          return target.check(call, ctx);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
