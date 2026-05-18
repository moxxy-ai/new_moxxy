import { definePlugin, type CommandDef, type Plugin } from '@moxxy/sdk';

/**
 * Minimal shape we expect on the `ctx.session` argument. Loose typing
 * keeps this package free of a core dependency — the host always
 * passes a real Session that satisfies this surface.
 */
interface SessionShape {
  readonly id: string;
  readonly cwd: string;
  readonly providers: { getActiveName(): string | null };
  readonly loops: { getActive(): { name: string } | undefined };
  readonly tools: { list(): ReadonlyArray<unknown> };
  readonly skills: { list(): ReadonlyArray<unknown> };
  readonly agents: { list(): ReadonlyArray<{ name: string; description: string }> };
  readonly commands: { list(): ReadonlyArray<CommandDef> };
  readonly pluginHost: { list(): ReadonlyArray<unknown> };
}

const infoCmd: CommandDef = {
  name: 'info',
  description: 'Show provider · model · loop · plugin/skill counts',
  handler: ({ session }) => {
    const s = session as SessionShape;
    const lines = [
      `session:   ${s.id}`,
      `cwd:       ${s.cwd}`,
      `provider:  ${safe(() => s.providers.getActiveName()) ?? '(none)'}`,
      `loop:      ${safe(() => s.loops.getActive()?.name) ?? '(none)'}`,
      `tools:     ${s.tools.list().length}`,
      `skills:    ${s.skills.list().length}`,
      `agents:    ${s.agents.list().length}`,
      `plugins:   ${s.pluginHost.list().length}`,
      `commands:  ${s.commands.list().length}`,
    ];
    return { kind: 'text', text: lines.join('\n') };
  },
};

const clearCmd: CommandDef = {
  name: 'clear',
  description: 'Clear the chat scrollback (event log stays intact in resumed sessions)',
  handler: () => ({ kind: 'session-action', action: 'clear', notice: 'scrollback cleared' }),
};

const newCmd: CommandDef = {
  name: 'new',
  description: 'Start a fresh session (drops conversation history; keeps provider/loop)',
  handler: () => ({
    kind: 'session-action',
    action: 'new',
    notice: 'new session — conversation history cleared',
  }),
};

const exitCmd: CommandDef = {
  name: 'exit',
  description: 'Quit the current channel',
  aliases: ['quit', 'q'],
  handler: () => ({ kind: 'session-action', action: 'exit' }),
};

const helpCmd: CommandDef = {
  name: 'help',
  description: 'List every command available in this channel',
  handler: ({ session, channel }) => {
    const s = session as SessionShape;
    const visible = s.commands
      .list()
      .filter((c) => !c.channels || c.channels.includes(channel))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (visible.length === 0) return { kind: 'text', text: '(no commands registered)' };
    const longest = visible.reduce((m, c) => Math.max(m, c.name.length), 0);
    const lines = visible.map(
      (c) => `/${c.name.padEnd(longest)}  ${c.description}`,
    );
    return { kind: 'text', text: lines.join('\n') };
  },
};

/**
 * `@moxxy/plugin-commands` — registers the channel-agnostic command
 * set every channel inherits via `session.commands`. Drop it and
 * those commands disappear; the TUI's channel-local pickers (model,
 * loop, mcp, yolo, overlay-style stuff) keep working since they
 * remain inside the TUI itself.
 */
export const commandsPlugin: Plugin = definePlugin({
  name: '@moxxy/plugin-commands',
  version: '0.0.0',
  commands: [infoCmd, clearCmd, newCmd, exitCmd, helpCmd],
});

export default commandsPlugin;

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
