/**
 * Safe, hand-written templating + condition evaluation for workflows.
 *
 * NO `eval` / `new Function` — same posture as the isolators security stance.
 * Templates substitute `{{ ref }}` placeholders; conditions support a tiny,
 * explicit grammar only. Anything outside the grammar is a syntax error
 * surfaced at author time (`workflow_validate` / `workflow_create`).
 */

export interface TemplateScope {
  /** Completed step outputs, keyed by step id. */
  readonly steps: Record<string, { readonly output: string }>;
  /** Resolved workflow inputs (defaults applied). */
  readonly inputs: Record<string, unknown>;
  /** What fired the run (`{{ trigger }}`). */
  readonly trigger?: string;
  /** ISO timestamp for `{{ now }}`. */
  readonly now?: string;
  /** Ad-hoc variables (`{{ vars.x }}`). */
  readonly vars?: Record<string, unknown>;
}

const REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Resolve a dotted reference (e.g. `steps.fetch.output`) to a raw value. */
function resolveRef(ref: string, scope: TemplateScope): unknown {
  const parts = ref.split('.').map((p) => p.trim());
  const [head, ...rest] = parts;
  switch (head) {
    case 'trigger':
      return scope.trigger ?? '';
    case 'now':
      return scope.now ?? '';
    case 'steps': {
      const id = rest[0];
      if (!id) return undefined;
      const out = scope.steps[id]?.output;
      // `steps.x` and `steps.x.output` both resolve to the step's output.
      return out ?? '';
    }
    case 'inputs':
      return rest[0] ? scope.inputs[rest[0]] : undefined;
    case 'vars':
      return rest[0] ? scope.vars?.[rest[0]] : undefined;
    default:
      return undefined;
  }
}

export interface RenderOptions {
  readonly logger?: { warn?(msg: string, meta?: Record<string, unknown>): void };
}

/** Substitute every `{{ ref }}` in `text`. Unknown refs render empty. */
export function renderTemplate(text: string, scope: TemplateScope, opts: RenderOptions = {}): string {
  return text.replace(REF_RE, (_match, ref: string) => {
    const value = resolveRef(ref.trim(), scope);
    if (value === undefined) {
      opts.logger?.warn?.('workflow template: unresolved reference', { ref: ref.trim() });
      return '';
    }
    return stringifyValue(value);
  });
}

/** Deep-render string leaves of an args object/array. */
export function renderArgs(args: unknown, scope: TemplateScope, opts: RenderOptions = {}): unknown {
  if (typeof args === 'string') return renderTemplate(args, scope, opts);
  if (Array.isArray(args)) return args.map((v) => renderArgs(v, scope, opts));
  if (args && typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = renderArgs(v, scope, opts);
    }
    return out;
  }
  return args;
}

// ----------------------------------------------------------------------------
// Condition DSL
// ----------------------------------------------------------------------------
//
//   <lhs> contains "literal"
//   <lhs> == "literal"
//   <lhs> != "literal"
//   <lhs> is empty
//   <lhs> is not empty
//
// joined by `and` / `or` (OR-of-ANDs; `and` binds tighter than `or`).
// <lhs> is a `{{ ref }}` template or a bare dotted ref. Literals are
// double-quoted; avoid embedding ` and `/` or ` inside a literal in v1.

type Atom =
  | { readonly kind: 'contains' | 'eq' | 'neq'; readonly lhs: string; readonly literal: string }
  | { readonly kind: 'empty' | 'notEmpty'; readonly lhs: string };

const ATOM_PATTERNS: ReadonlyArray<{ re: RegExp; build: (m: RegExpMatchArray) => Atom }> = [
  { re: /^(.+?)\s+is\s+not\s+empty$/i, build: (m) => ({ kind: 'notEmpty', lhs: m[1]!.trim() }) },
  { re: /^(.+?)\s+is\s+empty$/i, build: (m) => ({ kind: 'empty', lhs: m[1]!.trim() }) },
  { re: /^(.+?)\s+contains\s+"(.*)"$/i, build: (m) => ({ kind: 'contains', lhs: m[1]!.trim(), literal: m[2]! }) },
  { re: /^(.+?)\s+==\s+"(.*)"$/, build: (m) => ({ kind: 'eq', lhs: m[1]!.trim(), literal: m[2]! }) },
  { re: /^(.+?)\s+!=\s+"(.*)"$/, build: (m) => ({ kind: 'neq', lhs: m[1]!.trim(), literal: m[2]! }) },
];

/** Split `expr` on a top-level connective word, ignoring quoted regions. */
function splitTop(expr: string, connective: 'and' | 'or'): string[] {
  const parts: string[] = [];
  let depth = 0; // inside double-quotes when odd
  let buf = '';
  const words = expr.split(/(\s+)/); // keep whitespace tokens
  for (const w of words) {
    for (const ch of w) if (ch === '"') depth ^= 1;
    if (depth === 0 && w.toLowerCase() === connective) {
      parts.push(buf);
      buf = '';
    } else {
      buf += w;
    }
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseAtom(text: string): Atom {
  for (const { re, build } of ATOM_PATTERNS) {
    const m = text.match(re);
    if (m) return build(m);
  }
  throw new ConditionSyntaxError(`unrecognized condition clause: "${text}"`);
}

export class ConditionSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionSyntaxError';
  }
}

interface ParsedCondition {
  /** OR of AND-groups. */
  readonly orGroups: ReadonlyArray<ReadonlyArray<Atom>>;
}

function parseCondition(expr: string): ParsedCondition {
  const trimmed = expr.trim();
  if (!trimmed) throw new ConditionSyntaxError('empty condition');
  const orGroups = splitTop(trimmed, 'or').map((group) => splitTop(group, 'and').map(parseAtom));
  return { orGroups };
}

function evalAtom(atom: Atom, scope: TemplateScope): boolean {
  const value = renderTemplate(atom.lhs.includes('{{') ? atom.lhs : `{{ ${atom.lhs} }}`, scope).trim();
  switch (atom.kind) {
    case 'empty':
      return value === '';
    case 'notEmpty':
      return value !== '';
    case 'contains':
      return value.includes(atom.literal);
    case 'eq':
      return value === atom.literal;
    case 'neq':
      return value !== atom.literal;
  }
}

/** Evaluate a condition against the scope. Throws on syntax error. */
export function evalCondition(expr: string, scope: TemplateScope): boolean {
  const { orGroups } = parseCondition(expr);
  return orGroups.some((group) => group.every((atom) => evalAtom(atom, scope)));
}

/** Author-time check: returns an error message, or null when the syntax is valid. */
export function validateCondition(expr: string): string | null {
  try {
    parseCondition(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
