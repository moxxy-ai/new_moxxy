import type { LLMProvider } from '@moxxy/sdk';
import { parseWorkflowYaml, type WorkflowParseResult } from './schema.js';

/**
 * Draft a workflow YAML from a natural-language intent — the agentic
 * authoring path behind `workflow_create`. Mirrors `draftSkill`: stream the
 * active provider, extract the YAML block, validate it against the schema.
 */

export interface DraftCatalogEntry {
  readonly name: string;
  readonly description: string;
}

export interface DraftWorkflowOptions {
  readonly availableSkills?: ReadonlyArray<DraftCatalogEntry>;
  readonly availableTools?: ReadonlyArray<DraftCatalogEntry>;
  readonly maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 4096;

export function buildSystemPrompt(opts: DraftWorkflowOptions): string {
  const skills = formatCatalog(
    opts.availableSkills,
    '(none registered — use `prompt` steps with clear instructions)',
  );
  const tools = formatCatalog(opts.availableTools, '(none — use `delivery: { channel: inbox }` for notifications)');
  return `You are a workflow author for the "moxxy" agent. Output ONLY a YAML document (optionally inside a \`\`\`yaml fence) — no prose before or after.

A workflow is a DAG of steps. Schema:
- name: kebab-case slug (lowercase letters/numbers/hyphens, starts with a letter)
- description: one clear sentence matching the user's goal (never "A simple Moxxy workflow.")
- enabled: true
- on (optional triggers): { schedule: { cron: "m h dom mon dow", timeZone? }, afterWorkflow?, fileChanged?, webhook? }
- inputs (optional): { <name>: { default: <value>, description: "..." } } — use for values the operator supplies at run time (e.g. recipient email, image brief)
- delivery (optional): { channel?: "inbox", inbox?: true }
- steps: array of steps, each with:
    - id: slug, unique
    - label: short human title (match the user's language when possible)
    - EXACTLY ONE action: skill | prompt | tool | workflow | bridge | condition | switch
    - bridge: instruction — logic step; agent returns JSON with vars (extract/transform data); optional format: plain
    - condition: instruction + then: [step ids] + else: [step ids] — agent returns JSON branch then|else
    - switch: instruction + cases: { <caseId>: [step ids], ... } + optional default: [step ids] — agent returns JSON branch matching a case id
    - input: templated instruction for skill steps
    - prompt: templated instruction for prompt steps (multiline allowed with |)
    - args: templated args object for tool/workflow steps
    - needs: [ <upstream step ids> ]  (defines the DAG; omit only for true sources)
    - when (optional, legacy): simple guards only — '{{ steps.x.output }} is not empty'. Do NOT use when for semantic decisions (use condition/switch).
    - awaitInput (optional, prompt/skill only): true — pause after the subagent's first message; the operator replies once in Virtual Office chat, then the step completes and the DAG continues
    - onError (optional): fail | continue | retry ; retries (optional, 0-3)

Templating: {{ steps.<id>.output }}, {{ inputs.<name> }}, {{ vars.<name> }}, {{ trigger }}, {{ now }}.

Logic steps: default response is one JSON object (vars, branch, optional text). Describe semantics in the instruction; do not repeat JSON syntax unless needed. No awaitInput on bridge/condition/switch.

Ordering: steps whose \`needs\` are all satisfied run in parallel — chain with \`needs\` for sequential pipelines.

Authoring rules:
1. Decompose the intent into concrete steps. Multi-phase requests (collect → act → summarize → deliver) need at least 4 steps with a linear or fan-in \`needs\` chain.
2. Values the operator should provide **in chat** (search topic, recipient email, brief, clarifications): one \`awaitInput: true\` step **per distinct question** (e.g. \`collect_topic\`, then later \`collect_email\`). Never rely on a single awaitInput step to cover multiple unrelated inputs. One chat reply per awaitInput step; use \`{{ steps.<id>.output }}\` downstream.
3. \`inputs\` are only for data known **before** Run (API keys, fixed defaults). Do NOT add \`inputs\` for topic/email when the user asked you to "ask" for them — use awaitInput steps instead. Never write descriptions like "workflow will ask before run" for fields you did not wire to an awaitInput step.
4. Do NOT add a prompt/skill step that only says "ask the operator" without \`awaitInput: true\` — that finishes in one turn and stores the question as output.
5. Research + report + email intents: typical chain — \`collect_topic\` (awaitInput) → \`web-research\` skill → \`write_report\` → \`collect_email\` (awaitInput) → \`send_email\` tool; reference \`{{ steps.collect_topic.output }}\` and \`{{ steps.collect_email.output }}\`, not empty \`inputs\`.
6. Use ONLY skill/tool names from the catalogs below — never placeholders like "<< skill-name >>", "TBD", or empty skill/tool fields.
7. Prefer a listed skill when its description fits; otherwise use a detailed \`prompt\` step.
8. For email/notify: use a listed mail/MCP tool if available; else \`delivery: { channel: inbox }\`.
9. For image generation: use a listed image/generation tool if available; else a \`prompt\` step that describes producing the image artifact in text.
10. Later steps must read prior results via \`{{ steps.<id>.output }}\`, extracted fields via \`{{ vars.<name> }}\`, and operator data via \`{{ inputs.<name> }}\` — never invent example emails or briefs in prompts.
11. Between incompatible steps insert \`bridge\` to extract fields into vars (e.g. email from chat). Use \`condition\` for if/else routing, \`switch\` for multi-way (e.g. value > 100 → pies, < 0 → kot, else nieokreslony).
12. Prefer bridge + vars over passing raw chat output to tools.

Available skills (name — description):
${skills}

Available tools (name — description):
${tools}

Example shape for internet research → report → email (two awaitInput steps):
\`\`\`yaml
name: internet-research-report-email
description: Ask for search topic and recipient email in chat, research, report, and send.
enabled: true
steps:
  - id: collect_topic
    label: Zapytaj o temat
    awaitInput: true
    prompt: |
      Zapytaj operatora po polsku, czego szukać w internecie (temat, zakres, język).
      Po odpowiedzi zwróć krótki brief wyszukiwania.
  - id: search_web
    needs: [collect_topic]
    label: Wyszukaj w internecie
    skill: web-research
    input: |
      Przeprowadź research według briefu:
      {{ steps.collect_topic.output }}
  - id: write_report
    needs: [search_web]
    label: Przygotuj raport
    prompt: |
      Napisz raport po polsku z wyników researchu.
      Brief: {{ steps.collect_topic.output }}
      Research: {{ steps.search_web.output }}
  - id: collect_email
    needs: [write_report]
    label: Zapytaj o e-mail
    awaitInput: true
    prompt: |
      Zapytaj operatora po polsku o adres e-mail odbiorcy raportu.
      Po odpowiedzi zwróć sam adres e-mail (jedna linia).
  - id: extract_email
    needs: [collect_email]
    label: Wyciągnij e-mail
    bridge: Z wątku collect_email wyciągnij sam adres do vars.email.
  - id: send_email
    needs: [write_report, extract_email]
    label: Wyślij e-mail
    tool: gmail_send
    args:
      to: ["{{ vars.email }}"]
      subject: "Raport z researchu"
      body: "{{ steps.write_report.output }}"
\`\`\`

Example shape for awaitInput brief → generate → report → email:
\`\`\`yaml
name: image-report-email
description: Collect image brief in chat, generate image, write a report, and email it.
enabled: true
steps:
  - id: collect_brief
    label: Collect image brief
    awaitInput: true
    prompt: |
      Ask the operator what image to generate (subject, style, format, mood, colors).
      After they reply, return a concise structured brief only.
  - id: generate_image
    needs: [collect_brief]
    label: Generate image
    prompt: |
      Generate the image from this brief:
      {{ steps.collect_brief.output }}
      Return the artifact path or id and short generation notes.
  - id: write_report
    needs: [generate_image]
    label: Write report
    prompt: |
      Write a concise report in the operator's language.
      Brief: {{ steps.collect_brief.output }}
      Generation: {{ steps.generate_image.output }}
  - id: collect_email
    needs: [write_report]
    label: Zapytaj o e-mail
    awaitInput: true
    prompt: |
      Zapytaj operatora o adres e-mail odbiorcy raportu.
      Po odpowiedzi zwróć sam adres e-mail.
  - id: send_email
    needs: [collect_email]
    label: Send email
    tool: mcp__gmail__send_message
    args:
      to: ["{{ steps.collect_email.output }}"]
      subject: "Raport z wygenerowanego zdjęcia"
      body: "{{ steps.prepare_email.output }}"
\`\`\`
(Replace tool names with ones from the catalog when drafting.)`;
}

function formatCatalog(
  entries: ReadonlyArray<DraftCatalogEntry> | undefined,
  emptyLabel: string,
): string {
  if (!entries?.length) return emptyLabel;
  return entries
    .map((entry) => `- ${entry.name}${entry.description ? ` — ${entry.description}` : ''}`)
    .join('\n');
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
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
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
