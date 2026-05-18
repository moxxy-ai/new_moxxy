import { defineTool, z, type AgentDef, type SubagentSpec } from '@moxxy/sdk';

const agentSpecSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('The task the sub-agent should perform. Phrase as a focused, self-contained request.'),
  agentType: z
    .string()
    .optional()
    .describe(
      'Named agent kind to spawn (e.g. "researcher", "code-reviewer"). Looked ' +
        'up in the agent registry contributed by installed plugins. Omit, or ' +
        'pass "default", for a generic tool-use agent. Unknown types fall back ' +
        'to default — the request never fails over a missing kind. List of ' +
        'currently-registered kinds is visible via the /agents command.',
    ),
  label: z
    .string()
    .max(60)
    .optional()
    .describe('Short label shown in progress events (e.g. "research-deps", "lint-fix-A").'),
  systemPrompt: z
    .string()
    .optional()
    .describe(
      'Override the kind\'s system prompt. Use to set persona, constraints, ' +
        'or hand off upstream artifacts the child needs as context.',
    ),
  model: z
    .string()
    .optional()
    .describe('Model id override; defaults to the kind\'s model, then the parent\'s.'),
  loopStrategy: z
    .string()
    .optional()
    .describe(
      'Loop strategy override. Valid values: "tool-use" (default), ' +
        '"plan-execute", "bmad". OMIT for the kind\'s default — do NOT invent names.',
    ),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe('Restrict the child to these tool names. Overrides the kind\'s allowlist if set.'),
});

// NOTE: `maxIterations` is intentionally absent from the model-facing
// schema. Models tend to hallucinate small numbers (4, 5, 10) when
// given a free integer field, which causes legitimate research tasks
// to fail with `loop exceeded maxIterations (4)`. The cap belongs on
// the AgentDef (per-kind, set by the plugin author) or the spawner
// default (50), not on the per-call payload.

type AgentSpecInput = z.infer<typeof agentSpecSchema>;

export interface DispatchAgentDeps {
  /** Live lookup against the session's agent registry. Closure-bound at
   *  plugin construction so handler reads see fresh state. */
  readonly getAgent: (name: string) => AgentDef | undefined;
}

/** Built-in "default" kind — surfaced when the model omits agentType or
 *  passes an unknown one. Never registered in the AgentRegistry so
 *  plugins can override it cleanly via `replace()` if they want. */
const DEFAULT_AGENT: AgentDef = {
  name: 'default',
  description:
    'Generic tool-use loop. Inherits the parent\'s full tool registry; no system prompt override.',
};

export function buildDispatchAgentTool(deps: DispatchAgentDeps) {
  return defineTool({
    name: 'dispatch_agent',
    description:
      'Spawn one or more focused sub-agents in parallel. Use when a task fans out ' +
      'into independent subtasks (multi-source research, per-file refactor, ' +
      'multi-perspective review). Each child runs in isolation and returns its ' +
      'final message; children stream their progress so you see what each one is ' +
      'doing in real time. Pass `agentType` to pick a specialized kind from the ' +
      'agent registry (see /agents); omit for the default generic agent. Unknown ' +
      'kinds fall back to the default instead of erroring.',
    inputSchema: z.object({
      agents: z
        .array(agentSpecSchema)
        .min(1)
        .max(8)
        .describe('Specs for the agents to spawn. Run in parallel; results returned in order.'),
    }),
    handler: async (input, ctx) => {
      if (!ctx.subagents) {
        throw new Error(
          'dispatch_agent: no subagent spawner available — this tool must be invoked from a run-turn loop.',
        );
      }
      const specs: SubagentSpec[] = (input.agents as AgentSpecInput[]).map((s) =>
        resolveSpec(s, deps),
      );
      const results = await ctx.subagents.spawnAll(specs);
      return {
        results: results.map((r) => ({
          label: r.label,
          childSessionId: String(r.childSessionId),
          text: r.text,
          stopReason: r.stopReason,
          ...(r.error ? { error: r.error.message } : {}),
        })),
      };
    },
  });
}

/**
 * Merge a model-supplied spec with the registered agent kind. Caller
 * fields win over kind defaults; omitted caller fields fall back to
 * the kind, which falls back to the built-in DEFAULT.
 */
function resolveSpec(input: AgentSpecInput, deps: DispatchAgentDeps): SubagentSpec {
  const requested = input.agentType ?? 'default';
  const def = deps.getAgent(requested) ?? DEFAULT_AGENT;
  const merged: SubagentSpec = {
    prompt: input.prompt,
    label: input.label ?? def.name,
  };
  const systemPrompt = input.systemPrompt ?? def.systemPrompt;
  if (systemPrompt !== undefined) (merged as { systemPrompt?: string }).systemPrompt = systemPrompt;
  const model = input.model ?? def.model;
  if (model !== undefined) (merged as { model?: string }).model = model;
  const loopStrategy = input.loopStrategy ?? def.loopStrategy;
  if (loopStrategy !== undefined)
    (merged as { loopStrategy?: string }).loopStrategy = loopStrategy;
  // maxIterations only comes from the AgentDef now (the input schema
  // doesn't expose it — see comment in agentSpecSchema above).
  if (def.maxIterations !== undefined)
    (merged as { maxIterations?: number }).maxIterations = def.maxIterations;
  const allowedTools = input.allowedTools ?? def.allowedTools;
  if (allowedTools !== undefined)
    (merged as { allowedTools?: ReadonlyArray<string> }).allowedTools = allowedTools;
  return merged;
}
