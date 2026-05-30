import type { WorkflowLogicStepFormat, WorkflowStep } from '@moxxy/sdk';

const PLAIN_PROMPT_MARKERS = [
  'odpowiedz wyłącznie zwykłym tekstem',
  'odpowiedz tylko zwykłym tekstem',
  'without json',
  'no json',
  'plain text only',
] as const;

const LOGIC_SYSTEM_PROMPT =
  'You are a workflow logic step. Do not use tools. Reply with exactly one JSON object. ' +
  'Use keys as needed: "vars" (object, data for downstream templates), "branch" (string, routing decision), ' +
  '"text" (optional human-readable summary). No markdown fences or commentary outside the JSON.';

export interface ParsedLogicResponse {
  readonly output: string;
  readonly vars?: Record<string, unknown>;
  readonly branch?: string;
}

export function logicSystemPrompt(): string {
  return LOGIC_SYSTEM_PROMPT;
}

export function wantsPlainResponse(step: WorkflowStep): boolean {
  if (step.format === 'plain') return true;
  if (step.format === 'json') return false;
  const text = (step.bridge ?? step.condition ?? step.switch ?? '').toLowerCase();
  return PLAIN_PROMPT_MARKERS.some((m) => text.includes(m));
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  return fence ? fence[1]!.trim() : trimmed;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('logic step response must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function parseLogicResponse(
  raw: string,
  step: WorkflowStep,
  format: WorkflowLogicStepFormat,
): ParsedLogicResponse {
  if (format === 'plain') {
    return { output: raw.trim() };
  }

  const obj = parseJsonObject(raw);
  const vars =
    obj.vars != null && typeof obj.vars === 'object' && !Array.isArray(obj.vars)
      ? (obj.vars as Record<string, unknown>)
      : undefined;
  const branch = typeof obj.branch === 'string' ? obj.branch.trim() : undefined;
  const text = typeof obj.text === 'string' ? obj.text : undefined;
  const output = text ?? JSON.stringify(obj);
  return { output, ...(vars ? { vars } : {}), ...(branch ? { branch } : {}) };
}

export function resolveBranchForCondition(
  step: WorkflowStep,
  branch: string | undefined,
): 'then' | 'else' | undefined {
  if (!branch) return undefined;
  const b = branch.toLowerCase();
  if (b === 'then') return 'then';
  if (b === 'else') return 'else';
  return undefined;
}

export function resolveBranchForSwitch(
  step: WorkflowStep,
  branch: string | undefined,
): string | undefined {
  if (!branch) return undefined;
  const cases = step.cases ?? {};
  if (branch in cases) return branch;
  if (step.default && step.default.length > 0) return '__default__';
  return undefined;
}

export function stepsToSkipForBranch(
  step: WorkflowStep,
  selected: 'then' | 'else' | string,
): ReadonlyArray<string> {
  if (step.condition != null) {
    const then = step.then ?? [];
    const els = step.else ?? [];
    const active = selected === 'then' ? then : els;
    const all = [...then, ...els];
    return all.filter((id) => !active.includes(id));
  }
  if (step.switch != null) {
    const cases = step.cases ?? {};
    const all = new Set<string>();
    for (const ids of Object.values(cases)) for (const id of ids) all.add(id);
    for (const id of step.default ?? []) all.add(id);
    if (selected === '__default__') {
      const keep = new Set(step.default ?? []);
      return [...all].filter((id) => !keep.has(id));
    }
    const keep = new Set(cases[selected] ?? []);
    return [...all].filter((id) => !keep.has(id));
  }
  return [];
}
