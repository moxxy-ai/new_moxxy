import type { MoxxyEvent, UserPromptAttachment } from './events.js';
import type { SessionId, TurnId } from './ids.js';
import type { EventLogReader } from './log.js';
import type { ApprovalResolver } from './mode.js';
import type { PermissionResolver } from './permission.js';
import type { ModelDescriptor } from './provider.js';
import type { ToolCompactPresentation } from './tool.js';

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

/** How a provider authenticates. UIs use this to decide whether to
 *  show an API-key field or kick off an OAuth flow. */
export type ProviderAuthKind = 'api-key' | 'oauth';

/** Serializable provider metadata (models + context windows + auth)
 *  for display. */
export interface ProviderInfo {
  readonly name: string;
  readonly models: ReadonlyArray<ModelDescriptor>;
  /** 'oauth' when the provider declares an oauth login on its plugin
   *  definition, 'api-key' otherwise. Defaults to 'api-key' for
   *  providers that don't declare. */
  readonly authKind: ProviderAuthKind;
  /** True when the provider's plugin can list its models live (e.g.
   *  via /v1/models). Lets the desktop's model picker show a
   *  "Fetch live" affordance only where it makes sense. */
  readonly supportsLiveModelDiscovery: boolean;
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
  readonly output: string;
  readonly error?: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly status: string; readonly error?: string }>;
}

/**
 * The slice of the workflows API a channel needs to drive the `/workflows`
 * modal (list, enable/disable toggle, run). Present on a local Session when
 * `@moxxy/plugin-workflows` is wired; a `RemoteSession` leaves
 * {@link SessionLike.workflows} undefined and the UI degrades gracefully.
 */
export interface WorkflowsView {
  list(): Promise<ReadonlyArray<WorkflowSummaryView>>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  run(name: string): Promise<WorkflowRunView>;
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
}
