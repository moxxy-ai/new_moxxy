import type { LoopStrategyDef } from '@moxxy/sdk';

export class LoopRegistry {
  private readonly strategies = new Map<string, LoopStrategyDef>();
  private active: string | null = null;

  /**
   * Register a strategy. Throws on duplicate — use `replace()` for
   * overwrite. Auto-activates on first registration (loops need a default
   * for any session to work).
   */
  register(strategy: LoopStrategyDef): void {
    if (this.strategies.has(strategy.name)) {
      throw new Error(`Loop strategy already registered: ${strategy.name}`);
    }
    this.strategies.set(strategy.name, strategy);
    if (!this.active) this.active = strategy.name;
  }

  replace(strategy: LoopStrategyDef): void {
    this.strategies.set(strategy.name, strategy);
    if (!this.active) this.active = strategy.name;
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

  list(): ReadonlyArray<LoopStrategyDef> {
    return [...this.strategies.values()];
  }

  setActive(name: string): void {
    if (!this.strategies.has(name)) throw new Error(`Loop strategy not registered: ${name}`);
    this.active = name;
  }

  getActive(): LoopStrategyDef {
    if (!this.active) throw new Error('No active loop strategy registered.');
    const s = this.strategies.get(this.active);
    if (!s) throw new Error(`Active loop strategy missing: ${this.active}`);
    return s;
  }
}
