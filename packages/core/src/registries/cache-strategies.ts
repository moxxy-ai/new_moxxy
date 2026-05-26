import type { CacheStrategyDef } from '@moxxy/sdk';

/**
 * One active prompt-caching strategy per session. Mirrors
 * {@link CompactorRegistry}: register throws on duplicate, auto-activates the
 * first, and `unregister` clears the active slot rather than picking an
 * arbitrary successor.
 */
export class CacheStrategyRegistry {
  private readonly strategies = new Map<string, CacheStrategyDef>();
  private active: string | null = null;

  register(s: CacheStrategyDef): void {
    if (this.strategies.has(s.name)) {
      throw new Error(`Cache strategy already registered: ${s.name}`);
    }
    this.strategies.set(s.name, s);
    if (!this.active) this.active = s.name;
  }

  replace(s: CacheStrategyDef): void {
    this.strategies.set(s.name, s);
    if (!this.active) this.active = s.name;
  }

  unregister(name: string): void {
    this.strategies.delete(name);
    if (this.active === name) this.active = null;
  }

  list(): ReadonlyArray<CacheStrategyDef> {
    return [...this.strategies.values()];
  }

  setActive(name: string): void {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new Error(`Cache strategy not registered: ${name}`);
    this.active = strategy.name;
  }

  getActive(): CacheStrategyDef | null {
    if (!this.active) return null;
    return this.strategies.get(this.active) ?? null;
  }
}
