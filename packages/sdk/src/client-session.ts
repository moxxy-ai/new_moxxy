import type { AgentDef } from './agent.js';
import type { CommandDef } from './command.js';
import type { ModeDef } from './mode.js';
import type { LLMProvider, ProviderDef } from './provider.js';
import type { RequirementCheck, MoxxyRequirement } from './requirements.js';
import type { SessionLike, SessionLogReader } from './session-like.js';
import type { Skill } from './skill.js';
import type { ToolDef } from './tool.js';
import type { Transcriber } from './transcriber.js';

/**
 * `ClientSession` widens {@link SessionLike} with the read-and-act registry
 * surface a rich interactive channel (the Ink TUI) actually touches. Both the
 * in-process `Session` (whose concrete registries are supersets of these
 * views) and the `RemoteSession` proxy implement it, so the TUI is written
 * once against `ClientSession` and runs unchanged either way.
 *
 * The views are intentionally narrow - only what the TUI calls. Methods are
 * declared method-style (bivariant) so a concrete `Session` registry satisfies
 * the view even where its real signature is slightly wider. On a remote
 * client, the facades behind these views are backed by the runner's `getInfo`
 * snapshot for reads and by RPCs for the few mutating calls; genuinely
 * server-only capabilities (voice transcription, MCP admin) degrade rather
 * than pretend.
 */

export interface ProvidersClientView {
  getActive(): LLMProvider;
  getActiveName(): string | null;
  list(): ReadonlyArray<ProviderDef>;
  setActive(name: string, config?: Record<string, unknown>): LLMProvider;
  replace(def: ProviderDef, instance?: LLMProvider): void;
}

export interface ModesClientView {
  list(): ReadonlyArray<ModeDef>;
  getActive(): ModeDef;
  setActive(name: string): void;
}

export interface ToolsClientView {
  list(): ReadonlyArray<ToolDef>;
  get(name: string): ToolDef | undefined;
}

export interface CommandsClientView {
  get(name: string): CommandDef | undefined;
  listForChannel(channel: string): ReadonlyArray<CommandDef>;
}

export interface SkillsClientView {
  list(): ReadonlyArray<Skill>;
}

export interface AgentsClientView {
  list(): ReadonlyArray<AgentDef>;
}

export interface TranscribersClientView {
  getActiveName(): string | null;
  has(name: string): boolean;
  getActive(): Transcriber;
  /** Active transcriber or null. Channels guard on this for audio input. */
  tryGetActive(): Transcriber | null;
  setActive(name: string, config?: Record<string, unknown>): Transcriber;
}

export interface RequirementsClientView {
  check(requirements: ReadonlyArray<MoxxyRequirement>): RequirementCheck;
}

export interface PermissionsClientView {
  addAllow(rule: { readonly name: string; readonly reason?: string }): Promise<void>;
}

export interface ClientSession extends SessionLike {
  /** The mirror/real log, plus `clear()` for `/new`. */
  readonly log: SessionLogReader & { clear(): void };
  readonly providers: ProvidersClientView;
  readonly modes: ModesClientView;
  readonly tools: ToolsClientView;
  readonly commands: CommandsClientView;
  readonly skills: SkillsClientView;
  readonly agents: AgentsClientView;
  readonly transcribers: TranscribersClientView;
  readonly requirements: RequirementsClientView;
  readonly permissions: PermissionsClientView;
}
