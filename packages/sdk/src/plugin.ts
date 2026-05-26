import type { AgentDef } from './agent.js';
import type { CacheStrategyDef } from './cache-strategy.js';
import type { ChannelDef } from './channel.js';
import type { CommandDef } from './command.js';
import type { CompactorDef } from './compactor.js';
import type { LifecycleHooks } from './hooks.js';
import type { ModeDef } from './mode.js';
import type { ProviderDef } from './provider.js';
import type { MoxxyRequirement } from './requirements.js';
import type { ToolDef } from './tool.js';
import type { TranscriberDef } from './transcriber.js';

export type PluginKind = 'tools' | 'provider' | 'mode' | 'compactor' | 'cache-strategy' | 'mcp' | 'cli' | 'channel' | 'hooks' | 'agent' | 'command' | 'transcriber';

export interface PluginSpec {
  readonly name: string;
  readonly version?: string;
  readonly tools?: ReadonlyArray<ToolDef>;
  readonly providers?: ReadonlyArray<ProviderDef>;
  readonly modes?: ReadonlyArray<ModeDef>;
  readonly compactors?: ReadonlyArray<CompactorDef>;
  /**
   * Prompt-caching strategies contributed by the plugin. One is active per
   * session (selected via `session.cacheStrategies.setActive(name)`); the
   * active strategy decides where cache breakpoints go for each provider call.
   */
  readonly cacheStrategies?: ReadonlyArray<CacheStrategyDef>;
  readonly channels?: ReadonlyArray<ChannelDef>;
  /**
   * Speech-to-text backends contributed by the plugin. Selected by name via
   * `session.transcribers.setActive(name)`; channels with audio input use
   * `session.transcribers.getActive()` to convert bytes → transcript when
   * the active provider does not advertise `supportsAudio`.
   */
  readonly transcribers?: ReadonlyArray<TranscriberDef>;
  /**
   * Typed subagent kinds the plugin contributes. Each becomes
   * dispatchable as `dispatch_agent({ agentType: <name>, ... })`.
   * When NO plugin registers any agents (and no plugin registers the
   * dispatch tool itself), the model has no subagent capability and
   * the system degrades to the normal single-loop flow.
   */
  readonly agents?: ReadonlyArray<AgentDef>;
  /**
   * Slash commands contributed to every channel — the TUI's slash
   * menu, the Telegram bot's command list, and any future channel
   * that consumes `session.commands`. Use this for actions that make
   * sense regardless of UI (`/info`, `/clear`, custom domain commands
   * like `/deploy`); leave channel-specific UI commands (overlay
   * pickers, raw-mode toggles) inside the channel itself.
   */
  readonly commands?: ReadonlyArray<CommandDef>;
  readonly hooks?: LifecycleHooks;
  readonly skillsDir?: string;
}

export interface Plugin extends PluginSpec {
  readonly __moxxy: 'plugin';
  readonly version: string;
}

export interface PluginManifest {
  readonly entry: string;
  readonly kind?: PluginKind | ReadonlyArray<PluginKind>;
  readonly skills?: string;
}

export interface ResolvedPluginManifest extends PluginManifest {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packagePath: string;
  /**
   * Requirements declared at `package.json#moxxy.requirements`. Statically
   * authored — never derived from code. Drives plugin toposort and the
   * pre-load readiness gate.
   */
  readonly requirements?: ReadonlyArray<MoxxyRequirement>;
}
