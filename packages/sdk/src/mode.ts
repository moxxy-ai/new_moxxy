import type { CacheStrategyDef } from './cache-strategy.js';
import type { CompactorDef } from './compactor.js';
import type { EmittedEvent, MoxxyEvent } from './events.js';
import type { HookDispatcher } from './hooks.js';
import type { SessionId, TurnId } from './ids.js';
import type { EventLogReader } from './log.js';
import type { PermissionResolver } from './permission.js';
import type { LLMProvider } from './provider.js';
import type { Skill } from './skill.js';
import type { SubagentSpawner } from './subagent.js';
import type { ToolDef } from './tool.js';

export interface ToolRegistry {
  list(): ReadonlyArray<ToolDef>;
  get(name: string): ToolDef | undefined;
  execute(name: string, input: unknown, signal: AbortSignal, opts?: ToolExecuteOpts): Promise<unknown>;
}

export interface ToolExecuteOpts {
  readonly callId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly log?: EventLogReader;
  readonly cwd?: string;
}

export interface SkillRegistry {
  list(): ReadonlyArray<Skill>;
  get(id: string): Skill | undefined;
  byName(name: string): Skill | undefined;
  filterByTriggers(prompt: string): ReadonlyArray<Skill>;
}

export interface PluginHostHandle {
  list(): ReadonlyArray<{ name: string; version: string; loaded: boolean }>;
  reload(): Promise<void>;
}

/**
 * Turn-boundary elision (context-on-demand) settings, resolved from config and
 * carried on the ModeContext. All fields optional; {@link runElisionIfNeeded}
 * applies defaults and floors (e.g. keepRecentTurns is floored at 2).
 */
export interface ElisionSettings {
  readonly enabled?: boolean;
  readonly keepRecentTurns?: number;
  readonly minContextRatioToElide?: number;
  readonly elideConversational?: boolean;
  readonly conversationalRecallThreshold?: number;
  readonly maxRecallBytes?: number;
  readonly neverElideTools?: ReadonlyArray<string>;
}

export interface ModeContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly log: EventLogReader;
  readonly compactor: CompactorDef | null;
  /** Active prompt-caching strategy (or null when none is registered). */
  readonly cacheStrategy: CacheStrategyDef | null;
  /** Elision (context-on-demand) settings; undefined → defaults apply. */
  readonly elision?: ElisionSettings;
  /** When true, send only always-on + loaded tool schemas; index the rest. */
  readonly lazyTools?: boolean;
  readonly permissions: PermissionResolver;
  /**
   * Optional generic "ask the user a question" gate. Any loop strategy can
   * call this to surface a checkpoint to the user — plan-execute uses it
   * after producing a plan, but a code-execution loop could use it for
   * "run this command?" or a refactor loop for "apply this diff?". When
   * absent (headless / non-TTY), strategies should proceed as if the user
   * picked the default option, or fail closed depending on the strategy.
   */
  readonly approval?: ApprovalResolver;
  readonly hooks: HookDispatcher;
  readonly pluginHost: PluginHostHandle;
  readonly signal: AbortSignal;
  readonly maxIterations?: number;
  /**
   * Spawn one or more child agents that share the parent's registries
   * but run in isolation. Children stream their events back to the
   * parent log as `plugin_event` records with `subagent_*` subtypes.
   * Absent in synthetic test contexts that don't model a full Session.
   */
  readonly subagents?: SubagentSpawner;
  emit(event: EmittedEvent): Promise<MoxxyEvent>;
}

/**
 * Generic approval-dialog request. The TUI renders `title` as the header,
 * `body` as a verbatim block (plan text, diff, command preview, etc.), and
 * a single-select list of `options`. An option may set `requestsText` so
 * the dialog prompts for follow-up text after selection (e.g. redraft
 * feedback). `kind` is a loose tag the dialog/CLI can use for styling.
 */
export interface ApprovalRequest {
  readonly title: string;
  readonly body: string;
  readonly options: ReadonlyArray<ApprovalOption>;
  readonly defaultOptionId?: string;
  readonly kind?: string;
}

export interface ApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly hotkey?: string;
  readonly description?: string;
  readonly requestsText?: boolean;
  readonly textPrompt?: string;
  readonly danger?: boolean;
}

export interface ApprovalDecision {
  readonly optionId: string;
  /** Free-text follow-up the user typed when the option had `requestsText: true`. */
  readonly text?: string;
}

export interface ApprovalResolver {
  readonly name: string;
  confirm(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ModeDef {
  readonly name: string;
  run(ctx: ModeContext): AsyncIterable<MoxxyEvent>;
}
