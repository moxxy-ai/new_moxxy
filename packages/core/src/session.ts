import type { AppContext, LifecycleHooks, MoxxyEvent, SessionId } from '@moxxy/sdk';
import { newSessionId, newTurnId } from './events/factory.js';
import { EventLog } from './events/log.js';
import { HookDispatcherImpl } from './plugins/lifecycle.js';
import { PluginHost, type PluginLoader } from './plugins/host.js';
import { ProviderRegistry } from './registries/providers.js';
import { LoopRegistry } from './registries/loops.js';
import { CompactorRegistry } from './registries/compactors.js';
import { ChannelRegistryImpl } from './registries/channels.js';
import { SkillRegistryImpl } from './registries/skills.js';
import { ToolRegistryImpl, type ToolRegistry } from './registries/tools.js';
import { AgentRegistry } from './registries/agents.js';
import { PermissionEngine } from './permissions/engine.js';
import { autoAllowResolver } from './permissions/resolvers.js';
import type {
  ApprovalResolver,
  PendingToolCall,
  PermissionContext,
  PermissionResolver,
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
   * Pre-seeded event log. Used by `moxxy resume` to restore the
   * conversation from a persisted JSONL. Subscribers don't re-fire for
   * seeded events (the constructor pushes them directly), so plugin
   * hooks won't run for historical entries.
   */
  readonly log?: EventLog;
}

export class Session {
  readonly id: SessionId;
  readonly cwd: string;
  readonly log: EventLog;
  readonly logger: Logger;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly loops: LoopRegistry;
  readonly compactors: CompactorRegistry;
  readonly channels: ChannelRegistryImpl;
  readonly skills: SkillRegistryImpl;
  readonly agents: AgentRegistry;
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
    this.loops = new LoopRegistry();
    this.compactors = new CompactorRegistry();
    this.channels = new ChannelRegistryImpl();
    this.skills = new SkillRegistryImpl();
    this.agents = new AgentRegistry();
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
      loops: this.loops,
      compactors: this.compactors,
      channels: this.channels,
      agents: this.agents,
      dispatcher: this.dispatcher,
      loader: opts.pluginLoader,
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
    this.resolver = wrapWithPolicy(resolver, this.permissions);
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
): PermissionResolver {
  // Use a Proxy so any extra methods on the underlying resolver
  // (`abortAll`, channel-specific helpers) remain accessible — only
  // `check` is intercepted.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'check') {
        return async (call: PendingToolCall, ctx: PermissionContext) => {
          const policy = engine.check(call);
          if (policy) return policy;
          return target.check(call, ctx);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
