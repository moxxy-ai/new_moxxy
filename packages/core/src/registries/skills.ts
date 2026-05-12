import type { Skill, SkillRegistry } from '@moxxy/sdk';

export class SkillRegistryImpl implements SkillRegistry {
  private readonly byId = new Map<string, Skill>();
  private readonly byNameIdx = new Map<string, Skill>();

  list(): ReadonlyArray<Skill> {
    return [...this.byId.values()];
  }

  get(id: string): Skill | undefined {
    return this.byId.get(id);
  }

  byName(name: string): Skill | undefined {
    return this.byNameIdx.get(name);
  }

  filterByTriggers(prompt: string): ReadonlyArray<Skill> {
    const lower = prompt.toLowerCase();
    const matches: Skill[] = [];
    for (const skill of this.byId.values()) {
      const triggers = skill.frontmatter.triggers ?? [];
      if (triggers.some((t) => lower.includes(t.toLowerCase()))) matches.push(skill);
    }
    return matches;
  }

  /**
   * Register a skill. Throws on duplicate id — use `replace()` for
   * overwrite (or `replaceAll()` for atomic bulk swap).
   */
  register(skill: Skill): void {
    if (this.byId.has(skill.id)) {
      throw new Error(`Skill already registered: ${skill.id}`);
    }
    this.byId.set(skill.id, skill);
    this.byNameIdx.set(skill.frontmatter.name, skill);
  }

  replace(skill: Skill): void {
    this.byId.set(skill.id, skill);
    this.byNameIdx.set(skill.frontmatter.name, skill);
  }

  unregister(id: string): void {
    const skill = this.byId.get(id);
    if (!skill) return;
    this.byId.delete(id);
    this.byNameIdx.delete(skill.frontmatter.name);
  }

  clear(): void {
    this.byId.clear();
    this.byNameIdx.clear();
  }

  /**
   * Replace the registry's entire contents atomically (no observable empty
   * window). Used by `reload_skills` so a concurrent lookup never sees
   * zero skills while a rescan is in flight.
   */
  replaceAll(skills: ReadonlyArray<Skill>): void {
    const nextById = new Map<string, Skill>();
    const nextByName = new Map<string, Skill>();
    for (const s of skills) {
      nextById.set(s.id, s);
      nextByName.set(s.frontmatter.name, s);
    }
    // Synchronous swap: callers between these lines still see the OLD
    // registry (Maps aren't replaced, only repopulated). Clear+set is the
    // shortest synchronous window we can achieve in JS for Map fields.
    this.byId.clear();
    this.byNameIdx.clear();
    for (const [k, v] of nextById) this.byId.set(k, v);
    for (const [k, v] of nextByName) this.byNameIdx.set(k, v);
  }
}
