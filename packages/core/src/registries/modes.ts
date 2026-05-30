import type { ModeDef } from '@moxxy/sdk';

export class ModeRegistry {
  private readonly strategies = new Map<string, ModeDef>();
  private active: string | null = null;
  private readonly changeListeners = new Set<() => void>();

  /** Observe active-mode changes — used by the runner to broadcast
   *  InfoChanged so remote clients track a mode switch (whether it came from
   *  a `setMode` RPC or a mode handing off to another mode mid-session). */
  onActiveChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /**
   * Register a strategy. Throws on duplicate — use `replace()` for
   * overwrite. Auto-activates on first registration (modes need a default
   * for any session to work).
   */
  register(strategy: ModeDef): void {
    if (this.strategies.has(strategy.name)) {
      throw new Error(`Mode already registered: ${strategy.name}`);
    }
    this.strategies.set(strategy.name, strategy);
    if (!this.active) this.activate(strategy);
  }

  replace(strategy: ModeDef): void {
    this.strategies.set(strategy.name, strategy);
    if (!this.active) this.activate(strategy);
  }

  /**
   * Remove a strategy. If it was active, the active slot is cleared —
   * callers must `setActive()` explicitly rather than silently picking
   * some arbitrary "next" strategy.
   */
  unregister(name: string): void {
    this.strategies.delete(name);
    if (this.active === name) this.active = null;
  }

  list(): ReadonlyArray<ModeDef> {
    return [...this.strategies.values()];
  }

  setActive(name: string): void {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new Error(`Mode not registered: ${name}`);
    this.activate(strategy);
  }

  getActive(): ModeDef {
    if (!this.active) throw new Error('No active mode registered.');
    const s = this.strategies.get(this.active);
    if (!s) throw new Error(`Active mode missing: ${this.active}`);
    return s;
  }

  private activate(strategy: ModeDef): void {
    if (this.active === strategy.name) return;
    this.active = strategy.name;
    for (const fn of this.changeListeners) fn();
  }
}
