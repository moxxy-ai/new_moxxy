/**
 * Agent definitions — typed templates for subagent spawning. Each
 * `AgentDef` describes a flavor of subagent (researcher, code-reviewer,
 * summarizer, …) so plugins can register named agent kinds and the
 * `dispatch_agent` tool can spawn them by type instead of relying on
 * ad-hoc prompts.
 *
 * Why this lives in SDK (not core): the interface is the cross-package
 * contract. Plugins import `AgentDef` from `@moxxy/sdk`, register
 * agents via `PluginSpec.agents`, and the core's `AgentRegistry`
 * surfaces them at runtime.
 */
export interface AgentDef {
  /** Stable name; what `dispatch_agent({ agentType })` looks up. */
  readonly name: string;
  /** One-line user-visible summary — surfaced in the `/agents` modal. */
  readonly description: string;
  /**
   * System prompt prepended to the child's first message. Use to set
   * persona, output format, hard constraints, etc.
   */
  readonly systemPrompt?: string;
  /**
   * Loop strategy name for the child. Defaults to `'tool-use'`. The
   * spawner falls back to tool-use if the named strategy isn't
   * registered (no point failing a child over a missing block).
   */
  readonly loopStrategy?: string;
  /**
   * Restrict the child to these tools by name. Omit for full
   * inheritance from the parent's registry.
   */
  readonly allowedTools?: ReadonlyArray<string>;
  /** Default model id; overrides the parent's active model. */
  readonly model?: string;
  /** Per-child iteration cap. Defaults to 50. */
  readonly maxIterations?: number;
}
