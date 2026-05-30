/**
 * Subagent primitives — let a running loop strategy or tool spawn one or
 * more child agents that share the parent's tools / skills / providers /
 * permissions but have an isolated event log and (typically) a focused
 * task prompt. Children stream their work back to the parent log as
 * `plugin_event` records with `subagent_*` subtypes, so the TUI and other
 * subscribers can render progress live without waiting for the final
 * message.
 */

import type { SessionId } from './ids.js';
import type { StopReason } from './provider-utils.js';

export interface SubagentSpec {
  /** The user message the child sees as its prompt. */
  readonly prompt: string;
  /** Optional system prompt override for the child. */
  readonly systemPrompt?: string;
  /** Override model id; defaults to the parent's active model. */
  readonly model?: string;
  /** Mode name to run inside the child (default: `'tool-use'`). */
  readonly mode?: string;
  /** Per-child iteration cap (default 50). */
  readonly maxIterations?: number;
  /** Restrict the child to these tools by name. Omit for full inheritance. */
  readonly allowedTools?: ReadonlyArray<string>;
  /** Human-readable label surfaced in `subagent_*` event payloads. */
  readonly label?: string;
  /**
   * When true, the child session stays alive after the first turn for
   * {@link SubagentSpawner.continue}. `subagent_completed` is deferred until
   * continue or release.
   */
  readonly retainSession?: boolean;
}

export interface SubagentContinueArgs {
  readonly childSessionId: SessionId;
  readonly prompt: string;
  readonly label?: string;
}

export interface SubagentResult {
  readonly label: string;
  readonly childSessionId: SessionId;
  /** The child's final assistant text (or last non-empty text if it ended on a tool call). */
  readonly text: string;
  readonly stopReason: StopReason;
  /** Populated when the child loop errored fatally or threw. */
  readonly error?: { readonly message: string };
}

export interface SubagentSpawner {
  /** Run a single child to completion. */
  spawn(spec: SubagentSpec): Promise<SubagentResult>;
  /** Run N children in parallel; resolves with results in input order. */
  spawnAll(specs: ReadonlyArray<SubagentSpec>): Promise<ReadonlyArray<SubagentResult>>;
  /** Append a user turn and run the child again (requires `retainSession` spawn). */
  continue(args: SubagentContinueArgs): Promise<SubagentResult>;
  /** Drop a retained session without completing it. */
  release?(childSessionId: SessionId): void;
}
