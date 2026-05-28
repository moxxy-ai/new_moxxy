import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic, type Workflow } from '@moxxy/sdk';
import {
  defaultProjectWorkflowsDir,
  defaultUserWorkflowsDir,
  discoverWorkflows,
  type DiscoveredWorkflow,
  type WorkflowLogger,
} from './loader.js';
import { serializeWorkflow, validateWorkflow } from './schema.js';

/**
 * Owns the set of workflow artifacts: discovers them from disk on `load()`,
 * keeps them in an in-memory name→workflow map (the "registry" role), and
 * performs file CRUD for the authoring tools and the `/workflows` command.
 *
 * Builtin/plugin workflows are read-only; editing or toggling one writes a
 * user-scope override (later scopes win in discovery) rather than mutating a
 * package file.
 */

export type EditableScope = 'user' | 'project';

export interface WorkflowStoreOptions {
  readonly cwd: string;
  readonly userDir?: string;
  readonly projectDir?: string;
  readonly builtinDir?: string;
  readonly pluginDirs?: ReadonlyArray<string>;
  readonly logger?: WorkflowLogger;
}

export class WorkflowStore {
  private readonly byName = new Map<string, DiscoveredWorkflow>();
  private readonly opts: WorkflowStoreOptions;
  private loaded = false;

  constructor(opts: WorkflowStoreOptions) {
    this.opts = opts;
  }

  private userDir(): string {
    return this.opts.userDir ?? defaultUserWorkflowsDir();
  }

  private projectDir(): string {
    return this.opts.projectDir ?? defaultProjectWorkflowsDir(this.opts.cwd);
  }

  /** (Re)scan all sources and rebuild the in-memory map. */
  async load(): Promise<void> {
    const discovered = await discoverWorkflows({
      userDir: this.userDir(),
      projectDir: this.projectDir(),
      ...(this.opts.builtinDir ? { builtinDir: this.opts.builtinDir } : {}),
      ...(this.opts.pluginDirs ? { pluginDirs: this.opts.pluginDirs } : {}),
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
    this.byName.clear();
    for (const wf of discovered) this.byName.set(wf.workflow.name, wf);
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async list(): Promise<ReadonlyArray<DiscoveredWorkflow>> {
    await this.ensureLoaded();
    return [...this.byName.values()];
  }

  async get(name: string): Promise<DiscoveredWorkflow | undefined> {
    await this.ensureLoaded();
    return this.byName.get(name);
  }

  /** Synchronous lookup for hot paths (executor). Assumes `load()` already ran. */
  lookup(name: string): Workflow | undefined {
    return this.byName.get(name)?.workflow;
  }

  /** Write a new workflow file and register it. Rejects duplicate names. */
  async create(workflow: Workflow, scope: EditableScope): Promise<DiscoveredWorkflow> {
    await this.ensureLoaded();
    if (this.byName.has(workflow.name)) {
      throw new Error(`workflow "${workflow.name}" already exists — use update instead`);
    }
    const dir = scope === 'project' ? this.projectDir() : this.userDir();
    await fs.mkdir(dir, { recursive: true });
    const file = await uniqueFilename(dir, workflow.name);
    await writeFileAtomic(file, serializeWorkflow(workflow));
    const entry: DiscoveredWorkflow = { workflow, path: file, scope };
    this.byName.set(workflow.name, entry);
    return entry;
  }

  /**
   * Replace a workflow with a new definition. In-place rewrite for user/project
   * workflows; a user-scope override for builtin/plugin ones.
   */
  async save(workflow: Workflow): Promise<DiscoveredWorkflow> {
    await this.ensureLoaded();
    const existing = this.byName.get(workflow.name);
    const editable = existing && (existing.scope === 'user' || existing.scope === 'project');
    if (existing && editable) {
      await writeFileAtomic(existing.path, serializeWorkflow(workflow));
      const entry: DiscoveredWorkflow = { ...existing, workflow };
      this.byName.set(workflow.name, entry);
      return entry;
    }
    // New, or overriding a read-only builtin/plugin workflow → write to user dir.
    const dir = this.userDir();
    await fs.mkdir(dir, { recursive: true });
    const file = await uniqueFilename(dir, workflow.name);
    await writeFileAtomic(file, serializeWorkflow(workflow));
    const entry: DiscoveredWorkflow = { workflow, path: file, scope: 'user' };
    this.byName.set(workflow.name, entry);
    return entry;
  }

  /** Toggle a workflow's `enabled` flag, persisting the change. */
  async setEnabled(name: string, enabled: boolean): Promise<DiscoveredWorkflow | null> {
    await this.ensureLoaded();
    const existing = this.byName.get(name);
    if (!existing) return null;
    return this.save({ ...existing.workflow, enabled });
  }

  /** Delete a user/project workflow file. Read-only scopes cannot be deleted. */
  async delete(name: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ensureLoaded();
    const existing = this.byName.get(name);
    if (!existing) return { ok: false, reason: 'not found' };
    if (existing.scope !== 'user' && existing.scope !== 'project') {
      return { ok: false, reason: `cannot delete a ${existing.scope} workflow` };
    }
    await fs.rm(existing.path, { force: true });
    this.byName.delete(name);
    return { ok: true };
  }
}

async function uniqueFilename(dir: string, base: string): Promise<string> {
  const slug = slugify(base);
  let candidate = path.join(dir, `${slug}.yaml`);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${slug}-${n}.yaml`);
    n += 1;
  }
  return candidate;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Re-export for callers that only need the validation entry point. */
export { validateWorkflow };
