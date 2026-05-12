import type { CompactorDef } from '@moxxy/sdk';

export class CompactorRegistry {
  private readonly compactors = new Map<string, CompactorDef>();
  private active: string | null = null;

  /**
   * Register a compactor. Throws on duplicate — use `replace()` for
   * overwrite. Auto-activates on first registration.
   */
  register(c: CompactorDef): void {
    if (this.compactors.has(c.name)) {
      throw new Error(`Compactor already registered: ${c.name}`);
    }
    this.compactors.set(c.name, c);
    if (!this.active) this.active = c.name;
  }

  replace(c: CompactorDef): void {
    this.compactors.set(c.name, c);
    if (!this.active) this.active = c.name;
  }

  /**
   * Remove a compactor. If it was active, the active slot is cleared
   * (callers must `setActive()` rather than getting an arbitrary "next").
   */
  unregister(name: string): void {
    this.compactors.delete(name);
    if (this.active === name) this.active = null;
  }

  list(): ReadonlyArray<CompactorDef> {
    return [...this.compactors.values()];
  }

  setActive(name: string): void {
    if (!this.compactors.has(name)) throw new Error(`Compactor not registered: ${name}`);
    this.active = name;
  }

  getActive(): CompactorDef | null {
    if (!this.active) return null;
    return this.compactors.get(this.active) ?? null;
  }
}
