import type { CommandDef } from '@moxxy/sdk';

/**
 * Registry of `/<name>` slash commands shared across every channel.
 * Plugins contribute via `PluginSpec.commands`; channels read with
 * `list()` / `get()` / `match()` to render their picker and dispatch
 * matching user input.
 *
 * Naming conflicts throw at registration time so two plugins can't
 * silently shadow the same name — use `replace()` for explicit
 * overrides (e.g. user-config tweaks of a built-in).
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>();
  /** Reverse-lookup table: alias → primary name. */
  private readonly aliases = new Map<string, string>();

  register(cmd: CommandDef): void {
    if (this.commands.has(cmd.name)) {
      throw new Error(`Command already registered: /${cmd.name}`);
    }
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      if (this.aliases.has(alias) || this.commands.has(alias)) {
        throw new Error(`Command alias already in use: /${alias}`);
      }
      this.aliases.set(alias, cmd.name);
    }
  }

  replace(cmd: CommandDef): void {
    // Clean up any aliases of the prior definition before re-adding.
    const prior = this.commands.get(cmd.name);
    if (prior) {
      for (const alias of prior.aliases ?? []) this.aliases.delete(alias);
    }
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.aliases.set(alias, cmd.name);
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (!cmd) return;
    for (const alias of cmd.aliases ?? []) this.aliases.delete(alias);
    this.commands.delete(name);
  }

  get(name: string): CommandDef | undefined {
    const direct = this.commands.get(name);
    if (direct) return direct;
    const aliased = this.aliases.get(name);
    return aliased ? this.commands.get(aliased) : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): ReadonlyArray<CommandDef> {
    return [...this.commands.values()];
  }

  /**
   * Filter to commands visible in `channel`. Commands with no
   * `channels` field are visible everywhere; commands with a list are
   * visible only when `channel` appears in it.
   */
  listForChannel(channel: string): ReadonlyArray<CommandDef> {
    return this.list().filter(
      (c) => !c.channels || c.channels.includes(channel),
    );
  }
}
