import type { AgentDef } from '@moxxy/sdk';

/**
 * Registry of named subagent kinds contributed by plugins. The
 * `dispatch_agent` tool looks definitions up here by `agentType` and
 * uses them as templates (systemPrompt, allowedTools, mode, …)
 * for the spawned child.
 *
 * Mirrors the ModeRegistry / CompactorRegistry shape so plugin
 * registration and hot-reload follow the same pattern.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDef>();

  /**
   * Register a definition. Throws on duplicate so two plugins can't
   * silently shadow each other — use `replace()` when you really want
   * to override (e.g. user-config overrides).
   */
  register(def: AgentDef): void {
    if (this.agents.has(def.name)) {
      throw new Error(`Agent already registered: ${def.name}`);
    }
    this.agents.set(def.name, def);
  }

  replace(def: AgentDef): void {
    this.agents.set(def.name, def);
  }

  unregister(name: string): void {
    this.agents.delete(name);
  }

  list(): ReadonlyArray<AgentDef> {
    return [...this.agents.values()];
  }

  get(name: string): AgentDef | undefined {
    return this.agents.get(name);
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }
}
