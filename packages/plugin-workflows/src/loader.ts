import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Workflow } from '@moxxy/sdk';
import { parseWorkflowYaml } from './schema.js';

/**
 * Discover workflow artifacts from disk, mirroring `discoverSkills`: scan
 * builtin → plugin → user → project in priority order, later scopes
 * overriding earlier ones by workflow name. Each `.yaml`/`.yml` file holds
 * one workflow; invalid files are skipped with a logged warning.
 */

export type WorkflowScope = 'builtin' | 'plugin' | 'user' | 'project';

export interface WorkflowLogger {
  warn?(msg: string, meta?: Record<string, unknown>): void;
  info?(msg: string, meta?: Record<string, unknown>): void;
}

export interface DiscoveredWorkflow {
  readonly workflow: Workflow;
  readonly path: string;
  readonly scope: WorkflowScope;
}

export interface WorkflowLoadOptions {
  readonly projectDir?: string;
  readonly userDir?: string;
  readonly pluginDirs?: ReadonlyArray<string>;
  readonly builtinDir?: string;
  readonly logger?: WorkflowLogger;
}

export function defaultUserWorkflowsDir(): string {
  return path.join(os.homedir(), '.moxxy', 'workflows');
}

export function defaultProjectWorkflowsDir(cwd: string): string {
  return path.join(cwd, '.moxxy', 'workflows');
}

export async function discoverWorkflows(
  opts: WorkflowLoadOptions = {},
): Promise<ReadonlyArray<DiscoveredWorkflow>> {
  const sources: Array<{ dir: string; scope: WorkflowScope }> = [];
  if (opts.builtinDir) sources.push({ dir: opts.builtinDir, scope: 'builtin' });
  for (const dir of opts.pluginDirs ?? []) sources.push({ dir, scope: 'plugin' });
  sources.push({ dir: opts.userDir ?? defaultUserWorkflowsDir(), scope: 'user' });
  if (opts.projectDir) sources.push({ dir: opts.projectDir, scope: 'project' });

  const byName = new Map<string, DiscoveredWorkflow>();
  for (const source of sources) {
    for (const found of await loadDir(source.dir, source.scope, opts.logger)) {
      byName.set(found.workflow.name, found);
    }
  }
  return [...byName.values()];
}

async function loadDir(
  dir: string,
  scope: WorkflowScope,
  logger?: WorkflowLogger,
): Promise<ReadonlyArray<DiscoveredWorkflow>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredWorkflow[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await loadDir(path.join(dir, entry.name), scope, logger)));
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const raw = await fs.readFile(full, 'utf8');
    const result = parseWorkflowYaml(raw);
    if (!result.ok || !result.workflow) {
      logger?.warn?.('workflow: invalid file, skipping', { path: full, errors: result.errors });
      continue;
    }
    out.push({ workflow: result.workflow, path: full, scope });
  }
  return out;
}
