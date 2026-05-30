import type { Workflow } from '@moxxy/sdk';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { validateCondition } from './template.js';

/**
 * Validation for workflow artifacts. The SDK owns the structural TS types
 * ({@link Workflow} et al.); this module owns the zod schema that parses
 * on-disk YAML into them, plus the DAG-integrity checks (unique ids, edges
 * reference real steps, no cycles, exactly one action per step).
 */

const ACTION_KEYS = ['skill', 'prompt', 'tool', 'workflow', 'bridge', 'condition', 'switch'] as const;
const LOGIC_ACTION_KEYS = ['bridge', 'condition', 'switch'] as const;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

const stepSchema = z
  .object({
    id: z.string().min(1).max(80).regex(STEP_ID_RE, 'step id must be slug-like'),
    skill: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
    bridge: z.string().min(1).optional(),
    condition: z.string().min(1).optional(),
    then: z.array(z.string().min(1)).optional(),
    else: z.array(z.string().min(1)).optional(),
    switch: z.string().min(1).optional(),
    cases: z.record(z.array(z.string().min(1))).optional(),
    default: z.array(z.string().min(1)).optional(),
    input: z.string().optional(),
    args: z.record(z.unknown()).optional(),
    needs: z.array(z.string().min(1)).default([]),
    when: z.string().min(1).optional(),
    onError: z.enum(['fail', 'continue', 'retry']).default('fail'),
    retries: z.number().int().min(0).max(3).default(0),
    label: z.string().max(60).optional(),
    format: z.enum(['json', 'plain']).optional(),
    awaitInput: z.boolean().optional(),
  })
  .superRefine((step, ctx) => {
    const isLogic = LOGIC_ACTION_KEYS.some((k) => step[k] != null);
    if (step.awaitInput && (step.tool != null || step.workflow != null || isLogic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}": awaitInput is only allowed on prompt or skill steps`,
        path: ['awaitInput'],
      });
    }
    if (step.format === 'plain' && step.bridge == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}": format plain is only allowed on bridge steps`,
        path: ['format'],
      });
    }
    if (step.condition != null) {
      if (step.then == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}": condition requires then`,
          path: ['then'],
        });
      }
      if (step.else == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}": condition requires else`,
          path: ['else'],
        });
      }
    }
    if (step.switch != null) {
      const caseKeys = Object.keys(step.cases ?? {});
      if (caseKeys.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}": switch requires at least one case`,
          path: ['cases'],
        });
      }
    }
    if (step.then != null && step.condition == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}": then is only valid with condition`,
        path: ['then'],
      });
    }
    if (step.else != null && step.condition == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}": else is only valid with condition`,
        path: ['else'],
      });
    }
    if (step.cases != null && step.switch == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}": cases is only valid with switch`,
        path: ['cases'],
      });
    }
    if (step.default != null && step.switch == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}": default branch list is only valid with switch`,
        path: ['default'],
      });
    }
    const present = ACTION_KEYS.filter((k) => step[k] != null);
    if (present.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}" needs exactly one action (${ACTION_KEYS.join(' | ')})`,
        path: ['skill'],
      });
    } else if (present.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}" has multiple actions (${present.join(', ')}); pick one`,
        path: [present[1]!],
      });
    }
  });

const triggerSchema = z
  .object({
    schedule: z
      .object({
        cron: z.string().optional(),
        runAt: z.union([z.number().int(), z.string()]).optional(),
        timeZone: z.string().optional(),
      })
      .optional(),
    afterWorkflow: z.union([z.string(), z.array(z.string())]).optional(),
    fileChanged: z.union([z.string(), z.array(z.string())]).optional(),
    webhook: z.string().optional(),
  })
  .partial();

const inputSpecSchema = z.object({
  default: z.unknown().optional(),
  description: z.string().optional(),
});

const uiLayoutSchema = z.object({
  nodes: z.record(z.object({
    x: z.number(),
    y: z.number(),
  })).default({}),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
  }).optional(),
});

export const workflowSchema = z
  .object({
    name: z.string().min(1).max(120).regex(SLUG_RE, 'name must be slug-like'),
    description: z.string().min(1),
    version: z.number().int().default(1),
    enabled: z.boolean().default(true),
    inputs: z.record(inputSpecSchema).default({}),
    on: triggerSchema.optional(),
    delivery: z
      .object({
        channel: z.string().optional(),
        inbox: z.boolean().default(true),
      })
      .optional(),
    ui: z.object({
      layout: uiLayoutSchema.optional(),
    }).optional(),
    concurrency: z.number().int().min(1).max(8).default(4),
    steps: z.array(stepSchema).min(1).max(40),
  })
  .superRefine((wf, ctx) => {
    const ids = new Set<string>();
    for (const step of wf.steps) {
      if (ids.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step id "${step.id}"`,
          path: ['steps'],
        });
      }
      ids.add(step.id);
    }
    for (const step of wf.steps) {
      for (const dep of step.needs) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.id}" needs unknown step "${dep}"`,
            path: ['steps'],
          });
        }
      }
    }
    const cycle = findCycle(wf.steps);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `steps form a cycle: ${cycle.join(' → ')}`,
        path: ['steps'],
      });
    }
    for (const step of wf.steps) {
      if (step.when == null) continue;
      const err = validateCondition(step.when);
      if (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step "${step.id}" has an invalid \`when\` condition: ${err}`,
          path: ['steps'],
        });
      }
    }
    for (const step of wf.steps) {
      const branchIds: string[] = [];
      if (step.then) branchIds.push(...step.then);
      if (step.else) branchIds.push(...step.else);
      if (step.cases) for (const list of Object.values(step.cases)) branchIds.push(...list);
      if (step.default) branchIds.push(...step.default);
      for (const ref of branchIds) {
        if (!ids.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.id}" references unknown branch step "${ref}"`,
            path: ['steps'],
          });
        }
        if (ref === step.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.id}" cannot reference itself in then/else/cases/default`,
            path: ['steps'],
          });
        }
      }
    }
  });

/** DFS cycle detection over `needs` edges. Returns the cycle path or null. */
function findCycle(steps: ReadonlyArray<{ id: string; needs: ReadonlyArray<string> }>): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') {
      const from = stack.indexOf(id);
      return [...stack.slice(from), id];
    }
    const step = byId.get(id);
    if (!step) return null; // unknown dep already flagged elsewhere
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of step.needs) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const step of steps) {
    const found = visit(step.id);
    if (found) return found;
  }
  return null;
}

export interface WorkflowParseResult {
  readonly ok: boolean;
  readonly workflow?: Workflow;
  /** One readable line per issue, e.g. `steps: step "a" needs unknown step "x"`. */
  readonly errors: ReadonlyArray<string>;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((iss) => {
    const path = iss.path.join('.') || '(root)';
    return `${path}: ${iss.message}`;
  });
}

/** Validate an already-parsed object against the workflow schema. */
export function validateWorkflow(raw: unknown): WorkflowParseResult {
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  return { ok: true, workflow: parsed.data as Workflow, errors: [] };
}

/** Parse + validate a YAML document into a Workflow. */
export function parseWorkflowYaml(text: string): WorkflowParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { ok: false, errors: [`yaml: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return validateWorkflow(doc);
}

/** Serialize a Workflow back to canonical YAML (for `workflow_create` writes). */
export function serializeWorkflow(wf: Workflow): string {
  return stringifyYaml(wf, { lineWidth: 0 });
}
