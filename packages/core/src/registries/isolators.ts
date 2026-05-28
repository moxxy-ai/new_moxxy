import type { Isolator } from '@moxxy/sdk';

/**
 * Collection of capability isolators contributed by plugins via
 * `PluginSpec.isolators`. Unlike the single-active registries, this is just the
 * set of AVAILABLE isolators — selection (and ownership of the security
 * boundary) stays with the active security layer (`@moxxy/plugin-security`),
 * which reads these and picks one by `security.isolator` config.
 *
 * A contributed isolator is therefore NEVER auto-activated: registration only
 * makes it available; the user must opt in by name, so a rogue plugin can't
 * silently weaken isolation just by being installed.
 */
export class IsolatorRegistry {
  private readonly impls = new Map<string, Isolator>();

  register(iso: Isolator): void {
    // Overwrite by name: an isolator may arrive via more than one path (a
    // bundled built-in AND a discovered copy). Same name → same role; last wins.
    this.impls.set(iso.name, iso);
  }

  unregister(name: string): void {
    this.impls.delete(name);
  }

  get(name: string): Isolator | undefined {
    return this.impls.get(name);
  }

  has(name: string): boolean {
    return this.impls.has(name);
  }

  list(): ReadonlyArray<Isolator> {
    return [...this.impls.values()];
  }
}
