import type { EventLogReader } from './log.js';
import type { ProviderMessage } from './provider.js';
import type { ToolDef } from './tool.js';

/**
 * Lazy tool loading (request-scoped tool selection). Mirrors the skill
 * lazy-load idiom: instead of sending every tool schema on every call, send a
 * small always-on core plus whatever the model has explicitly loaded, and put
 * a compact one-line index of the rest in the system prompt. The model calls
 * `load_tool({ name })` to pull a schema in before using it.
 *
 * "Loaded" state is derived from the log (the `load_tool` calls), not a
 * separate mutable store — so projection stays a pure function of the log, the
 * same property that makes elision and caching deterministic.
 */

/** Core tools always sent in full — the agent's baseline capability + the
 * loaders themselves. Everything else is lazy-loadable when gating is on. */
export const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'recall',
  'load_skill',
  'load_tool',
  'dispatch_agent',
]);

/** Tool names the model has loaded this session (from `load_tool` calls). */
export function loadedToolNames(log: EventLogReader): ReadonlySet<string> {
  const names = new Set<string>();
  for (const e of log.ofType('tool_call_requested')) {
    if (e.name !== 'load_tool') continue;
    const input = e.input as { name?: unknown } | null | undefined;
    if (input && typeof input === 'object' && typeof input.name === 'string') {
      names.add(input.name);
    }
  }
  return names;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Compact index (name + 1-line description) of not-yet-loaded tools. */
export function buildToolIndex(hidden: ReadonlyArray<ToolDef>): string {
  const lines = hidden
    .map((t) => `- **${t.name}** — ${truncate(oneLine(t.description ?? ''), 100)}`)
    .join('\n');
  return (
    `## Loadable tools\n\n` +
    `These tools exist but their full schemas are not loaded right now. When a ` +
    `task needs one, call \`load_tool({ name: "<tool-name>" })\` first, then call ` +
    `the tool on the next turn.\n\n${lines}`
  );
}

function injectIntoSystem(
  messages: ReadonlyArray<ProviderMessage>,
  index: string,
): ProviderMessage[] {
  const out = messages.map((m) => m);
  const sysIdx = out.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    const sys = out[sysIdx]!;
    const content = sys.content.map((b) =>
      b.type === 'text' ? { ...b, text: `${b.text}\n\n${index}` } : b,
    );
    // If there was no text block, append one.
    if (!sys.content.some((b) => b.type === 'text')) {
      content.push({ type: 'text', text: index });
    }
    out[sysIdx] = { role: 'system', content };
    return out;
  }
  return [{ role: 'system', content: [{ type: 'text', text: index }] }, ...out];
}

export interface GatedTools {
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly tools: ReadonlyArray<ToolDef>;
}

/**
 * Apply lazy tool gating: keep always-on + loaded tools in the request, move
 * the rest into a system-prompt index. No-op (returns inputs) when nothing is
 * gated, so the system prompt stays byte-stable on turns that load nothing.
 */
export function applyLazyTools(
  messages: ReadonlyArray<ProviderMessage>,
  tools: ReadonlyArray<ToolDef>,
  log: EventLogReader,
): GatedTools {
  const loaded = loadedToolNames(log);
  const hidden = tools.filter((t) => !ALWAYS_ON_TOOLS.has(t.name) && !loaded.has(t.name));
  if (hidden.length === 0) return { messages, tools };
  const visible = tools.filter((t) => ALWAYS_ON_TOOLS.has(t.name) || loaded.has(t.name));
  return { messages: injectIntoSystem(messages, buildToolIndex(hidden)), tools: visible };
}
