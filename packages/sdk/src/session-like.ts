import type { MoxxyEvent, UserPromptAttachment } from './events.js';
import type { SessionId, TurnId } from './ids.js';
import type { EventLogReader } from './log.js';
import type { ApprovalResolver } from './mode.js';
import type { PermissionResolver } from './permission.js';
import type { ModelDescriptor } from './provider.js';
import type { ToolCompactPresentation } from './tool.js';
import type { Workflow } from './workflow.js';

/**
 * Options accepted by `SessionLike.runTurn`. Defined here (rather than in
 * `@moxxy/core`) so the runner client and any consumer can reference it
 * without importing the runtime. `@moxxy/core` re-exports it.
 */
export interface RunTurnOptions {
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly maxIterations?: number;
  /**
   * Per-turn abort signal. Aborting it cancels this turn without tainting
   * the session's own controller (e.g. "user hit Esc on a runaway loop").
   */
  readonly signal?: AbortSignal;
  /** Inline attachments shipped alongside the prompt (images, audio, stdin). */
  readonly attachments?: ReadonlyArray<UserPromptAttachment>;
  /**
   * Pre-minted turn id. When omitted, `runTurn` mints one. The runner passes
   * this so it can return the id to the client *before* the turn starts and
   * associate per-turn permission prompts with the originating client.
   */
  readonly turnId?: TurnId;
}

/**
 * The read side of the event log plus the live subscription a channel needs
 * to render in real time. A `RemoteSession` backs this with a local mirror
 * fed by the runner's event stream; a local `Session` backs it with the real
 * `EventLog`.
 */
export interface SessionLogReader extends EventLogReader {
  subscribe(fn: (event: MoxxyEvent) => void | Promise<void>): () => void;
}

/** Serializable provider metadata (models + context windows) for display. */
export interface ProviderInfo {
  readonly name: string;
  readonly models: ReadonlyArray<ModelDescriptor>;
}

/** Serializable tool metadata for status lines / slash menus / compact rendering. */
export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  /** Compact presentation hint (plain data - crosses the wire intact). */
  readonly compact?: ToolCompactPresentation;
}

/** Serializable skill metadata. */
export interface SkillInfo {
  readonly id: string;
  readonly name: string;
}

/** Serializable slash-command metadata for the picker / `/help`. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly channels?: ReadonlyArray<string>;
  readonly pendingNotice?: string;
}

/**
 * A wire-friendly snapshot of a session's registries - everything a channel
 * needs to *render* (status line, pickers, slash suggestions) without
 * reaching into live registry objects (`LLMProvider`, `ModeDef`, `ToolDef`)
 * whose methods can't cross a transport. A local `Session` builds it from its
 * registries; a `RemoteSession` fetches it from the runner and refreshes it
 * when the runner reports `info.changed`.
 */
export interface SessionInfo {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly activeProvider: string | null;
  readonly providers: ReadonlyArray<ProviderInfo>;
  readonly activeMode: string | null;
  readonly modes: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ToolInfo>;
  readonly skills: ReadonlyArray<SkillInfo>;
  readonly commands: ReadonlyArray<CommandInfo>;
  /** Provider names the runner has activated (credentials resolved). */
  readonly readyProviders: ReadonlyArray<string>;
  readonly hasTranscriber: boolean;
  /** Name of the active transcriber, or null. Lets a thin client proxy STT. */
  readonly activeTranscriber: string | null;
}

/**
 * Resolves a provider's stored credentials (vault tokens / API keys) into the
 * config object `providers.setActive` needs. The host installs one on a local
 * Session at boot; it is undefined across a `RemoteSession` transport (a closure
 * can't cross the wire — the runner side resolves credentials there instead).
 */
export type CredentialResolver = (providerName: string) => Promise<Record<string, unknown>>;

/** One server's status in {@link McpAdminView.listServers}. */
export interface McpServerStatusView {
  readonly name: string;
  readonly enabled: boolean;
  readonly connected: boolean;
}

/**
 * The slice of the MCP admin API a channel needs to drive the MCP picker and
 * status line. Present on a local Session when the MCP admin plugin is wired;
 * a `RemoteSession` leaves {@link SessionLike.mcpAdmin} undefined and the UI
 * degrades gracefully.
 */
export interface McpAdminView {
  enableAndAttach(name: string): Promise<{ toolNames: ReadonlyArray<string> } | null>;
  detach(name: string): Promise<boolean>;
  listServers(): Promise<ReadonlyArray<McpServerStatusView>>;
}

/** One workflow's summary for the `/workflows` modal. */
export interface WorkflowSummaryView {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly scope: string;
  readonly steps: number;
  /** Human-readable trigger summary, e.g. `cron(0 8 * * *)` or `on-demand`. */
  readonly triggers: string;
}

/** Result of running a workflow from the modal. */
export interface WorkflowRunView {
  readonly ok: boolean;
  readonly status: 'completed' | 'paused' | 'failed';
  readonly output: string;
  readonly error?: string;
  readonly runId?: string;
  readonly pendingStepId?: string;
  readonly interactionAgentId?: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly status: string; readonly error?: string }>;
}

export interface WorkflowDetailView {
  readonly workflow: Workflow;
  readonly scope: string;
  readonly path?: string;
  readonly yaml?: string;
}

export interface WorkflowValidationView {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
}

export interface WorkflowDraftView {
  readonly workflow: Workflow | null;
  readonly raw: string;
  readonly errors: ReadonlyArray<string>;
}

export interface WorkflowCapabilityItemView {
  readonly name: string;
  readonly description: string;
}

export interface WorkflowCapabilitiesView {
  readonly skills: ReadonlyArray<WorkflowCapabilityItemView>;
  readonly tools: ReadonlyArray<WorkflowCapabilityItemView>;
  /** MCP tools namespaced as `mcp__<server>__<tool>`. */
  readonly mcp: ReadonlyArray<WorkflowCapabilityItemView>;
  readonly workflows: ReadonlyArray<WorkflowCapabilityItemView>;
}

export type ScheduleSourceView = 'manual' | 'skill' | 'workflow';
export type ScheduleSourceFilterView = ScheduleSourceView | 'all';

export interface ScheduleEntryView {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly source: ScheduleSourceView;
  readonly skillName: string | null;
  readonly workflowName: string | null;
  readonly cron: string | null;
  readonly runAt: number | null;
  readonly timeZone: string | null;
  readonly channel: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly lastRunAt: string | null;
  readonly lastResult: 'ok' | 'error' | null;
  readonly lastError: string | null;
  readonly nextFireAt: number | null;
  readonly nextFireIso: string | null;
  readonly editable: boolean;
  readonly runnable: boolean;
}

export interface ScheduleListOptions {
  readonly source?: ScheduleSourceFilterView;
  readonly includeDisabled?: boolean;
}

export interface ScheduleCreateInput {
  readonly name: string;
  readonly prompt: string;
  readonly cron?: string;
  readonly runAt?: number | string;
  readonly timeZone?: string;
  readonly channel?: string;
  readonly model?: string;
  readonly enabled?: boolean;
}

export interface ScheduleUpdateInput {
  readonly name?: string;
  readonly prompt?: string;
  readonly cron?: string | null;
  readonly runAt?: number | string | null;
  readonly timeZone?: string | null;
  readonly channel?: string | null;
  readonly model?: string | null;
  readonly enabled?: boolean;
}

export interface ScheduleRunNowView {
  readonly ok: boolean;
  readonly text: string;
  readonly inboxPath?: string;
  readonly error?: string;
}

export interface SchedulerView {
  list(options?: ScheduleListOptions): Promise<ReadonlyArray<ScheduleEntryView>>;
  create(input: ScheduleCreateInput): Promise<ScheduleEntryView>;
  update(id: string, input: ScheduleUpdateInput): Promise<ScheduleEntryView | null>;
  setEnabled(id: string, enabled: boolean): Promise<ScheduleEntryView | null>;
  delete(id: string): Promise<{ readonly ok: boolean }>;
  runNow(id: string): Promise<ScheduleRunNowView>;
}

/**
 * The slice of the workflows API a channel needs to drive the `/workflows`
 * modal (list, enable/disable toggle, run). Present on a local Session when
 * `@moxxy/plugin-workflows` is wired; a `RemoteSession` leaves
 * {@link SessionLike.workflows} undefined and the UI degrades gracefully.
 */
export interface WorkflowsView {
  list(): Promise<ReadonlyArray<WorkflowSummaryView>>;
  get(name: string): Promise<WorkflowDetailView | null>;
  create(workflow: Workflow, scope?: 'user' | 'project'): Promise<WorkflowDetailView>;
  update(name: string, workflow: Workflow): Promise<WorkflowDetailView>;
  delete(name: string): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  validate(workflow: unknown): Promise<WorkflowValidationView>;
  draft(intent: string): Promise<WorkflowDraftView>;
  capabilities(): Promise<WorkflowCapabilitiesView>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  run(name: string, inputs?: Record<string, unknown>): Promise<WorkflowRunView>;
  /** Run a workflow definition without persisting it (desk-local office-flow). */
  runInline?(
    workflow: import('./workflow.js').Workflow,
    inputs?: Record<string, unknown>,
  ): Promise<WorkflowRunView>;
  /** Resume a paused workflow after operator replies to an awaitInput step. */
  reply?(runId: string, message: string): Promise<WorkflowRunView>;
}

/**
 * The session surface a `Channel` depends on, decoupled from whether the
 * session runs in-process (`@moxxy/core`'s `Session`) or is a thin-client
 * proxy (`RemoteSession` from `@moxxy/runner`). The same channel code drives
 * both - the runner/thin-client split hinges on this interface.
 *
 * Behavioral methods (`runTurn`, resolvers, `close`) and the live event log
 * are the contract; richer registry *behavior* (executing a tool, streaming a
 * provider) stays server-side and is never exposed here. For display, use the
 * serializable `getInfo()` snapshot instead of live registry objects.
 */
export interface SessionLike {
  readonly id: SessionId;
  readonly cwd: string;
  readonly log: SessionLogReader;
  runTurn(prompt: string, opts?: RunTurnOptions): AsyncIterable<MoxxyEvent>;
  setPermissionResolver(resolver: PermissionResolver): void;
  setApprovalResolver(resolver: ApprovalResolver | null): void;
  /** Wire-friendly registry snapshot for rendering. */
  getInfo(): SessionInfo;
  close(reason?: string): Promise<void>;

  /**
   * Live runtime capabilities present only on an in-process Session; a
   * `RemoteSession` thin client leaves them undefined, so callers MUST guard.
   * For plain display prefer the serializable {@link getInfo} snapshot — these
   * are for the mutate/guard paths a channel drives (provider switch, MCP picker).
   */
  /** Providers whose credentials resolved this session (live, mutable). */
  readyProviders?: Set<string>;
  /** Re-resolves a provider's credentials before `providers.setActive`. */
  credentialResolver?: CredentialResolver;
  /** MCP admin slice backing the MCP picker / status line. */
  mcpAdmin?: McpAdminView;
  /** Workflows slice backing the `/workflows` modal. */
  workflows?: WorkflowsView;
  /** Scheduler slice backing the Virtual Office Schedules screen. */
  scheduler?: SchedulerView;
}
