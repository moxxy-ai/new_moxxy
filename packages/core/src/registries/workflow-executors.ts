import type { WorkflowExecutorDef } from '@moxxy/sdk';

/**
 * Registry of swappable workflow-execution strategies. Mirrors
 * {@link ModeRegistry}: register throws on duplicate, auto-activates the
 * first registration (so a session always has an executor once
 * `@moxxy/plugin-workflows` loads its default `dag`), and `unregister`
 * clears the active slot rather than silently picking a successor.
 */
export class WorkflowExecutorRegistry {
  private readonly executors = new Map<string, WorkflowExecutorDef>();
  private active: string | null = null;

  register(def: WorkflowExecutorDef): void {
    if (this.executors.has(def.name)) {
      throw new Error(`Workflow executor already registered: ${def.name}`);
    }
    this.executors.set(def.name, def);
    if (!this.active) this.active = def.name;
  }

  replace(def: WorkflowExecutorDef): void {
    this.executors.set(def.name, def);
    if (!this.active) this.active = def.name;
  }

  unregister(name: string): void {
    this.executors.delete(name);
    if (this.active === name) this.active = null;
  }

  list(): ReadonlyArray<WorkflowExecutorDef> {
    return [...this.executors.values()];
  }

  setActive(name: string): void {
    const def = this.executors.get(name);
    if (!def) throw new Error(`Workflow executor not registered: ${name}`);
    this.active = def.name;
  }

  getActive(): WorkflowExecutorDef | null {
    if (!this.active) return null;
    return this.executors.get(this.active) ?? null;
  }
}
