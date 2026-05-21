import type { CompactorDef } from '@moxxy/sdk';
import { assertRequirementsReady, type RequirementChecker } from '../requirements.js';

export class CompactorRegistry {
  private readonly compactors = new Map<string, CompactorDef>();
  private active: string | null = null;
  private requirementChecker?: RequirementChecker;

  setRequirementChecker(checker: RequirementChecker): void {
    this.requirementChecker = checker;
  }

  /**
   * Register a compactor. Throws on duplicate — use `replace()` for
   * overwrite. Auto-activates on first registration.
   */
  register(c: CompactorDef): void {
    if (this.compactors.has(c.name)) {
      throw new Error(`Compactor already registered: ${c.name}`);
    }
    this.compactors.set(c.name, c);
    if (!this.active) this.activate(c);
  }

  replace(c: CompactorDef): void {
    this.compactors.set(c.name, c);
    if (!this.active) this.activate(c);
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
    const compactor = this.compactors.get(name);
    if (!compactor) throw new Error(`Compactor not registered: ${name}`);
    this.activate(compactor);
  }

  getActive(): CompactorDef | null {
    if (!this.active) return null;
    return this.compactors.get(this.active) ?? null;
  }

  private activate(compactor: CompactorDef): void {
    assertRequirementsReady(`compactor: ${compactor.name}`, compactor.requirements, this.requirementChecker);
    this.active = compactor.name;
  }
}
