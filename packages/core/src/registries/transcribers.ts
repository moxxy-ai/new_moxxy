import type { Transcriber, TranscriberDef } from '@moxxy/sdk';

/**
 * Registry of speech-to-text backends. Mirrors `ProviderRegistry`:
 *   - plugins call `register(def)` at load time
 *   - the host/CLI calls `setActive(name, config)` once a backend is chosen
 *   - channels with audio input read `getActive()` to transcribe bytes
 *
 * Like providers, there is at most one *active* transcriber at a time.
 * `getActive()` throws when none is active, so call sites can degrade
 * gracefully (e.g. Telegram falls back to "you sent a voice note but no
 * transcriber is configured").
 */
export class TranscriberRegistry {
  private readonly defs = new Map<string, TranscriberDef>();
  private readonly instances = new Map<string, Transcriber>();
  private active: string | null = null;

  register(def: TranscriberDef, instance?: Transcriber): void {
    if (this.defs.has(def.name)) {
      throw new Error(`Transcriber already registered: ${def.name}`);
    }
    this.defs.set(def.name, def);
    if (instance) this.instances.set(def.name, instance);
  }

  replace(def: TranscriberDef, instance?: Transcriber): void {
    this.defs.set(def.name, def);
    this.instances.delete(def.name);
    if (instance) this.instances.set(def.name, instance);
  }

  unregister(name: string): void {
    this.defs.delete(name);
    this.instances.delete(name);
    if (this.active === name) this.active = null;
  }

  list(): ReadonlyArray<TranscriberDef> {
    return [...this.defs.values()];
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  setActive(name: string, config?: Record<string, unknown>): Transcriber {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Transcriber not registered: ${name}`);
    let instance = this.instances.get(name);
    if (!instance) {
      instance = def.createClient(config ?? {});
      this.instances.set(name, instance);
    }
    this.active = name;
    return instance;
  }

  getActive(): Transcriber {
    if (!this.active) throw new Error('No active transcriber. Call setActive(name) first.');
    const inst = this.instances.get(this.active);
    if (!inst) throw new Error(`Active transcriber has no instance: ${this.active}`);
    return inst;
  }

  /** Active transcriber, or null when none is configured. Lets channels degrade gracefully. */
  tryGetActive(): Transcriber | null {
    if (!this.active) return null;
    return this.instances.get(this.active) ?? null;
  }

  getActiveName(): string | null {
    return this.active;
  }
}
