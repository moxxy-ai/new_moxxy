import { definePlugin, type AgentDef, type Plugin } from '@moxxy/sdk';
import { buildDispatchAgentTool, type DispatchAgentDeps } from './dispatch-agent.js';

export { buildDispatchAgentTool, type DispatchAgentDeps } from './dispatch-agent.js';

export interface BuildSubagentsPluginOpts {
  /**
   * How the tool resolves an `agentType` name → AgentDef at handler
   * time. Pass a closure that reads from your session's agent registry:
   * `(name) => session.agents.get(name)`.
   *
   * Defaults to "no agents registered" (always falls back to the
   * built-in default kind). Useful for standalone tests / scripts that
   * don't want to wire a session.
   */
  readonly getAgent?: (name: string) => AgentDef | undefined;
}

/**
 * `@moxxy/plugin-subagents` — adds the dispatch_agent tool + the
 * auto-detection skill ("dispatch-agents") that triggers on fan-out
 * patterns. Without this plugin the model can't spawn subagents — the
 * normal single-loop flow runs as usual.
 *
 * Other plugins can ship `AgentDef` kinds via their own
 * `PluginSpec.agents`. This plugin's tool resolves them at runtime, so
 * a freshly-installed agent kind becomes available the next time the
 * model calls dispatch_agent — no restart needed.
 */
export function buildSubagentsPlugin(opts: BuildSubagentsPluginOpts = {}): Plugin {
  const deps: DispatchAgentDeps = {
    getAgent: opts.getAgent ?? (() => undefined),
  };
  return definePlugin({
    name: '@moxxy/plugin-subagents',
    version: '0.0.0',
    tools: [buildDispatchAgentTool(deps)],
  });
}

export const subagentsPlugin = buildSubagentsPlugin();

export default subagentsPlugin;
