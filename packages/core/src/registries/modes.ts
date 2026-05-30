import type { ModeDef } from '@moxxy/sdk';

export class ModeRegistry {
  private readonly modes = new Map<string, ModeDef>();
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
   * Register a mode. Throws on duplicate — use `replace()` for
   * overwrite. Auto-activates on first registration (modes need a default
   * for any session to work).
   */
  register(mode: ModeDef): void {
    if (this.modes.has(mode.name)) {
      throw new Error(`Mode already registered: ${mode.name}`);
    }
    this.modes.set(mode.name, mode);
    if (!this.active) this.activate(mode);
  }

  replace(mode: ModeDef): void {
    this.modes.set(mode.name, mode);
    if (!this.active) this.activate(mode);
  }

  /**
   * Remove a mode. If it was active, the active slot is cleared —
   * callers must `setActive()` explicitly rather than silently picking
   * some arbitrary "next" mode.
   */
  unregister(name: string): void {
    this.modes.delete(name);
    if (this.active === name) this.active = null;
  }

  list(): ReadonlyArray<ModeDef> {
    return [...this.modes.values()];
  }

  setActive(name: string): void {
    const mode = this.modes.get(name);
    if (!mode) throw new Error(`Mode not registered: ${name}`);
    this.activate(mode);
  }

  getActive(): ModeDef {
    if (!this.active) throw new Error('No active mode registered.');
    const mode = this.modes.get(this.active);
    if (!mode) throw new Error(`Active mode missing: ${this.active}`);
    return mode;
  }

  private activate(mode: ModeDef): void {
    if (this.active === mode.name) return;
    this.active = mode.name;
    for (const fn of this.changeListeners) fn();
  }
}
