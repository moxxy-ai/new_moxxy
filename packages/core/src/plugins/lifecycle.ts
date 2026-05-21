import type {
  AppContext,
  HookDispatcher,
  LifecycleHooks,
  MoxxyEvent,
  Plugin,
  ProviderRequest,
  ToolCallContext,
  ToolCallVerdict,
  ToolResultContext,
  ToolResultEvent,
  TurnContext,
} from '@moxxy/sdk';
import type { Logger } from '../logger.js';

export interface DispatcherOptions {
  readonly hookTimeoutMs?: number;
  readonly logger: Logger;
  readonly onHookFailed?: (err: Error, plugin: string, hook: keyof LifecycleHooks) => void;
}

interface PluginEntry {
  readonly plugin: Plugin;
  readonly hooks: LifecycleHooks;
}

export class HookDispatcherImpl implements HookDispatcher {
  private entries: PluginEntry[] = [];
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly onHookFailed?: DispatcherOptions['onHookFailed'];

  constructor(opts: DispatcherOptions) {
    this.timeoutMs = opts.hookTimeoutMs ?? 5_000;
    this.logger = opts.logger;
    this.onHookFailed = opts.onHookFailed;
  }

  setPlugins(plugins: ReadonlyArray<Plugin>): void {
    this.entries = plugins.map((plugin) => ({ plugin, hooks: plugin.hooks ?? {} }));
  }

  async dispatchInit(ctx: AppContext): Promise<void> {
    for (const e of this.entries) await this.safe(e, 'onInit', () => e.hooks.onInit?.(ctx));
  }

  async dispatchTurnStart(ctx: TurnContext): Promise<void> {
    for (const e of this.entries) await this.safe(e, 'onTurnStart', () => e.hooks.onTurnStart?.(ctx));
  }

  async dispatchBeforeProviderCall(req: ProviderRequest, ctx: TurnContext): Promise<ProviderRequest> {
    let current = req;
    for (const e of this.entries) {
      const next = await this.safe(e, 'onBeforeProviderCall', () =>
        e.hooks.onBeforeProviderCall?.(current, ctx),
      );
      if (next) current = next;
    }
    return current;
  }

  async dispatchToolCall(ctx: ToolCallContext): Promise<ToolCallVerdict> {
    let verdict: ToolCallVerdict = { action: 'allow' };
    for (const e of this.entries) {
      const next = await this.safe(e, 'onToolCall', () => e.hooks.onToolCall?.(ctx));
      if (!next) continue;
      if (next.action === 'deny') return next;
      if (next.action === 'rewrite') verdict = next;
    }
    return verdict;
  }

  async dispatchToolResult(ctx: ToolResultContext): Promise<ToolResultEvent> {
    let result = ctx.result;
    for (const e of this.entries) {
      const next = await this.safe(e, 'onToolResult', () =>
        e.hooks.onToolResult?.({ ...ctx, result }),
      );
      if (next) result = next;
    }
    return result;
  }

  async dispatchEvent(event: MoxxyEvent, ctx: AppContext): Promise<void> {
    for (const e of this.entries) {
      await this.safe(e, 'onEvent', () => e.hooks.onEvent?.(event, ctx));
    }
  }

  async dispatchTurnEnd(ctx: TurnContext): Promise<void> {
    for (const e of this.entries) await this.safe(e, 'onTurnEnd', () => e.hooks.onTurnEnd?.(ctx));
  }

  async dispatchShutdown(ctx: AppContext): Promise<void> {
    for (const e of this.entries) await this.safe(e, 'onShutdown', () => e.hooks.onShutdown?.(ctx));
  }

  private async safe<T>(
    entry: PluginEntry,
    hook: keyof LifecycleHooks,
    fn: () => T | Promise<T> | void | Promise<void>,
  ): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const p = Promise.resolve(fn() as Promise<T | undefined | void>);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Hook ${hook} on ${entry.plugin.name} timed out`)),
          this.timeoutMs,
        );
      });
      // Attach a no-op rejection handler to the timeout promise so if the
      // fast path wins, the timer's eventual rejection is swallowed
      // silently rather than surfacing as an unhandled rejection.
      timeout.catch(() => undefined);
      const winner = await Promise.race([p, timeout]);
      return winner as T | undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn('hook failed', { plugin: entry.plugin.name, hook, err: error.message });
      this.onHookFailed?.(error, entry.plugin.name, hook);
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
