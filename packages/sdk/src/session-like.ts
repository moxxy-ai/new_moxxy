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
}
