import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  defineCommand,
  writeFileAtomic,
  type CommandContext,
  type CommandDef,
  type CommandOutput,
  type WorkflowRunResult,
} from '@moxxy/sdk';
import { defaultUserWorkflowsDir } from './loader.js';
import { serializeWorkflow } from './schema.js';
import type { WorkflowStore } from './store.js';

/**
 * The `/workflows` slash command — the required TUI surface for managing
 * flows. Lists every workflow with its enabled/disabled status, runs one on
 * demand, toggles enable/disable, inspects the last run, validates, scaffolds
 * a hand-editable starter (`new`), and deletes. Agentic creation lives in the
 * `workflow_create` tool (just ask in chat); this command covers by-hand
 * authoring and day-to-day management.
 */

export interface WorkflowCommandDeps {
  readonly store: WorkflowStore;
  /** Runs a workflow now (the autonomous runner). Absent → `run` is unavailable. */
  readonly runNow?: (input: {
    readonly name: string;
    readonly inputs?: Record<string, unknown>;
    readonly trigger?: string;
  }) => Promise<WorkflowRunResult>;
  readonly onChanged?: () => void | Promise<void>;
  readonly runRecordDir?: string;
  readonly userDir?: string;
}

const HELP = [
  'Usage: /workflows <subcommand>',
  '  list                 show all workflows (● enabled / ○ disabled)',
  '  run <name>           run a workflow now',
  '  enable <name>        enable a workflow',
  '  disable <name>       disable a workflow (keeps it, stops triggers)',
  '  inspect <name>       show the YAML + last run',
  '  validate <name>      re-check schema / DAG / conditions',
  '  new <name>           scaffold a starter YAML to edit by hand',
  '  edit <name>          print the on-disk path of a workflow',
  '  rm <name>            delete a user/project workflow',
  '',
  'Tip: to create one with the agent, just ask in chat — e.g.',
  '  "create a workflow that fetches Dow Jones news and emails me a digest".',
].join('\n');

export function buildWorkflowsCommand(deps: WorkflowCommandDeps): CommandDef {
  return defineCommand({
    name: 'workflows',
    description: 'List, run, enable/disable, inspect, and scaffold workflows.',
    argumentHint: 'list | run <name> | enable <name> | disable <name> | inspect <name> | new <name> | rm <name>',
    aliases: ['workflow', 'flows'],
    handler: (ctx) => handle(deps, ctx),
  });
}

async function handle(deps: WorkflowCommandDeps, ctx: CommandContext): Promise<CommandOutput> {
  const [sub, ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(' ').trim();
  try {
    switch ((sub ?? 'list').toLowerCase()) {
      case 'list':
      case 'ls':
        return await listCmd(deps);
      case 'run':
        return await runCmd(deps, arg);
      case 'enable':
        return await toggleCmd(deps, arg, true);
      case 'disable':
        return await toggleCmd(deps, arg, false);
      case 'inspect':
      case 'show':
        return await inspectCmd(deps, arg);
      case 'validate':
        return await validateCmd(deps, arg);
      case 'new':
        return await newCmd(deps, arg);
      case 'edit':
      case 'path':
        return await editCmd(deps, arg);
      case 'rm':
      case 'delete':
        return await rmCmd(deps, arg);
      case 'help':
        return { kind: 'text', text: HELP };
      default:
        return { kind: 'error', message: `unknown subcommand "${sub}".\n\n${HELP}` };
    }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function listCmd(deps: WorkflowCommandDeps): Promise<CommandOutput> {
  const all = await deps.store.list();
  if (all.length === 0) {
    return { kind: 'text', text: 'No workflows yet. `/workflows new <name>` to scaffold one, or ask the agent to "create a workflow that…".' };
  }
  const rows = [...all]
    .sort((a, b) => a.workflow.name.localeCompare(b.workflow.name))
    .map((w) => {
      const mark = w.workflow.enabled ? '●' : '○';
      const trig = triggerSummary(w.workflow.on);
      return `  ${mark} ${w.workflow.name}  [${w.scope}]  ${w.workflow.steps.length} steps  ${trig}\n      ${w.workflow.description}`;
    });
  return {
    kind: 'text',
    text: `Workflows (● enabled · ○ disabled):\n${rows.join('\n')}`,
  };
}

async function runCmd(deps: WorkflowCommandDeps, name: string): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: 'usage: /workflows run <name>' };
  const entry = await deps.store.get(name);
  if (!entry) return { kind: 'error', message: `no workflow named "${name}".` };
  if (!entry.workflow.enabled) return { kind: 'error', message: `workflow "${name}" is disabled — enable it first.` };
  if (!deps.runNow) {
    return { kind: 'text', text: `Ask the agent to run it: "run the ${name} workflow".` };
  }
  const result = await deps.runNow({ name, trigger: 'manual' });
  const steps = result.steps.map((s) => `  ${statusMark(s.status)} ${s.id}${s.error ? ` — ${s.error}` : ''}`).join('\n');
  const head = result.ok ? `✓ workflow "${name}" completed` : `✗ workflow "${name}" failed${result.error ? `: ${result.error}` : ''}`;
  return { kind: 'text', text: `${head}\n${steps}\n\n${truncate(result.output, 1200)}` };
}

async function toggleCmd(deps: WorkflowCommandDeps, name: string, enabled: boolean): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: `usage: /workflows ${enabled ? 'enable' : 'disable'} <name>` };
  const updated = await deps.store.setEnabled(name, enabled);
  if (!updated) return { kind: 'error', message: `no workflow named "${name}".` };
  await deps.onChanged?.();
  return { kind: 'text', text: `workflow "${name}" ${enabled ? 'enabled ●' : 'disabled ○'}.` };
}

async function inspectCmd(deps: WorkflowCommandDeps, name: string): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: 'usage: /workflows inspect <name>' };
  const entry = await deps.store.get(name);
  if (!entry) return { kind: 'error', message: `no workflow named "${name}".` };
  const lastRun = await readLastRun(deps.runRecordDir, name);
  const yaml = serializeWorkflow(entry.workflow);
  const parts = [`# ${name}  [${entry.scope}]  ${entry.path}`, '', yaml];
  if (lastRun) parts.push('', '— last run —', lastRun);
  return { kind: 'text', text: parts.join('\n') };
}

async function validateCmd(deps: WorkflowCommandDeps, name: string): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: 'usage: /workflows validate <name>' };
  const entry = await deps.store.get(name);
  if (!entry) return { kind: 'error', message: `no workflow named "${name}" (it would have been skipped on load if invalid).` };
  return { kind: 'text', text: `workflow "${name}" is valid (${entry.workflow.steps.length} steps).` };
}

async function newCmd(deps: WorkflowCommandDeps, name: string): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: 'usage: /workflows new <name>' };
  const slug = slugify(name);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { kind: 'error', message: `"${name}" is not a valid workflow name.` };
  const dir = deps.userDir ?? defaultUserWorkflowsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.yaml`);
  try {
    await fs.access(file);
    return { kind: 'error', message: `${file} already exists — edit it, or pick another name.` };
  } catch {
    /* does not exist — good */
  }
  await writeFileAtomic(file, starterTemplate(slug));
  await deps.onChanged?.();
  return {
    kind: 'text',
    text: `Scaffolded ${file}\nEdit it by hand, then \`/workflows validate ${slug}\` and \`/workflows run ${slug}\`.`,
  };
}

async function editCmd(deps: WorkflowCommandDeps, name: string): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: 'usage: /workflows edit <name>' };
  const entry = await deps.store.get(name);
  if (!entry) return { kind: 'error', message: `no workflow named "${name}".` };
  if (entry.scope !== 'user' && entry.scope !== 'project') {
    return { kind: 'text', text: `${entry.path}\n(${entry.scope} workflow — edits should go to a user override.)` };
  }
  return { kind: 'text', text: entry.path };
}

async function rmCmd(deps: WorkflowCommandDeps, name: string): Promise<CommandOutput> {
  if (!name) return { kind: 'error', message: 'usage: /workflows rm <name>' };
  const res = await deps.store.delete(name);
  if (!res.ok) return { kind: 'error', message: `cannot delete "${name}": ${res.reason}.` };
  await deps.onChanged?.();
  return { kind: 'text', text: `deleted workflow "${name}".` };
}

function statusMark(status: string): string {
  return status === 'completed' ? '✓' : status === 'skipped' ? '–' : status === 'failed' ? '✗' : '·';
}

function triggerSummary(on: import('@moxxy/sdk').WorkflowTrigger | undefined): string {
  if (!on) return 'on-demand';
  const parts: string[] = [];
  if (on.schedule?.cron) parts.push(`cron(${on.schedule.cron})`);
  if (on.schedule?.runAt) parts.push('runAt');
  if (on.afterWorkflow) parts.push(`after(${[on.afterWorkflow].flat().join(',')})`);
  if (on.fileChanged) parts.push('fileChanged');
  if (on.webhook) parts.push(`webhook(${on.webhook})`);
  return parts.length > 0 ? parts.join('+') : 'on-demand';
}

async function readLastRun(dir: string | undefined, name: string): Promise<string | null> {
  if (!dir) return null;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }
  const matches = files.filter((f) => f.includes(`-${name}-`) && f.endsWith('.jsonl')).sort();
  const latest = matches[matches.length - 1];
  if (!latest) return null;
  try {
    const raw = await fs.readFile(path.join(dir, latest), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const run = lines.find((l) => l.kind === 'run');
    const steps = lines.filter((l) => l.kind === 'step');
    const head = `${run?.ok ? '✓' : '✗'} ${new Date(Number(run?.startedAt ?? 0)).toISOString()} (${String(run?.trigger ?? '?')})`;
    const stepLines = steps.map((s) => `  ${statusMark(String(s.status))} ${String(s.id)}`).join('\n');
    return `${head}\n${stepLines}`;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function starterTemplate(slug: string): string {
  return `# Workflow: ${slug}
# A DAG of steps. Each step has exactly one action: skill | prompt | tool | workflow.
# Steps run once all their \`needs\` are satisfied — independent steps run in parallel.
name: ${slug}
description: Describe what this workflow does.
enabled: true

# Optional triggers (omit for on-demand only):
# on:
#   schedule: { cron: "0 8 * * 1-5", timeZone: "America/New_York" }
#   afterWorkflow: some-other-workflow
#   fileChanged: "./inbox/**"

# Optional inputs (referenced as {{ inputs.<name> }}):
# inputs:
#   topic: { default: "markets", description: "What to analyze" }

# delivery: { channel: inbox }   # also drop the final output into ~/.moxxy/inbox/

steps:
  - id: first
    prompt: "Replace me. Reference inputs like {{ inputs.topic }}."

  - id: second
    needs: [first]
    prompt: "Use the previous step's output:\\n{{ steps.first.output }}"
    # when: '{{ steps.first.output }} is not empty'
    # onError: continue
`;
}
