import type { LLMProvider } from '@moxxy/sdk';
import { parseWorkflowYaml, type WorkflowParseResult } from './schema.js';

/**
 * Draft a workflow YAML from a natural-language intent — the agentic
 * authoring path behind `workflow_create`. Mirrors `draftSkill`: stream the
 * active provider, extract the YAML block, validate it against the schema.
 */

export interface DraftWorkflowOptions {
  readonly availableSkills?: ReadonlyArray<string>;
  readonly availableTools?: ReadonlyArray<string>;
  readonly maxTokens?: number;
}

function buildSystemPrompt(opts: DraftWorkflowOptions): string {
  const skills = opts.availableSkills?.length
    ? opts.availableSkills.join(', ')
    : '(none registered — prefer `prompt` steps)';
  const tools = opts.availableTools?.length ? opts.availableTools.join(', ') : '(none)';
  return `You are a workflow author for the "moxxy" agent. Output ONLY a YAML document (optionally inside a \`\`\`yaml fence) — no prose.

A workflow is a DAG of steps. Schema:
- name: kebab-case slug (lowercase letters/numbers/hyphens, starts with a letter)
- description: one sentence
- on (optional triggers): { schedule: { cron: "m h dom mon dow", timeZone? }, afterWorkflow?, fileChanged?, webhook? }
- inputs (optional): { <name>: { default: <value>, description? } }
- delivery (optional): { channel?: "inbox", inbox?: true }
- steps: array of steps, each with:
    - id: slug, unique
    - EXACTLY ONE action: skill: <name> | prompt: <text> | tool: <name> | workflow: <name>
    - input: templated prompt for skill/prompt steps
    - args: templated args object for tool/workflow steps
    - needs: [ <upstream step ids> ]  (defines the DAG; omit for sources)
    - when (optional): a condition like '{{ steps.x.output }} is not empty' or '{{ inputs.r }} == "US"' or '... contains "text"', joined by and/or
    - onError (optional): fail | continue | retry ; retries (optional, 0-3)

Templating: reference earlier results with {{ steps.<id>.output }}, inputs with {{ inputs.<name> }}, plus {{ trigger }} and {{ now }}.

Steps with all their \`needs\` satisfied run in parallel, so use \`needs\` to express ordering and fan-out/fan-in.

Available skills: ${skills}
Available tools: ${tools}
Prefer a named skill when one fits; otherwise use a \`prompt\` step. For "send/email/notify me" use a connected tool if available, else rely on delivery: { channel: inbox }.`;
}

export interface DraftedWorkflow {
  readonly raw: string;
  readonly parse: WorkflowParseResult;
}

export async function draftWorkflow(
  provider: LLMProvider,
  model: string,
  intent: string,
  signal: AbortSignal,
  opts: DraftWorkflowOptions = {},
): Promise<DraftedWorkflow> {
  let accumulated = '';
  for await (const event of provider.stream({
    model,
    system: buildSystemPrompt(opts),
    messages: [{ role: 'user', content: [{ type: 'text', text: `Build a workflow for: ${intent}` }] }],
    maxTokens: opts.maxTokens ?? 1500,
    signal,
  })) {
    if (event.type === 'text_delta') accumulated += event.delta;
    if (event.type === 'error') throw new Error(`workflow_create: provider error: ${event.message}`);
  }
  const raw = extractYamlBlock(accumulated);
  return { raw, parse: parseWorkflowYaml(raw) };
}

function extractYamlBlock(s: string): string {
  const fence = /```(?:ya?ml)?\n([\s\S]*?)```/.exec(s);
  return (fence ? fence[1]! : s).trim();
}
