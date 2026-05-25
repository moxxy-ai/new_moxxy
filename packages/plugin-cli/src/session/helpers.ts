import type { Session } from '@moxxy/core';
import {
  BUILTIN_SLASH_COMMANDS,
  type SlashCommand,
} from '../components/SlashCommands.js';
import type { CommandDef } from '@moxxy/sdk';

export function resolveActiveModel(
  session: Session,
  override: string | null,
  prop: string | undefined,
): string {
  if (override) return override;
  if (prop) return prop;
  try {
    return session.providers.getActive().models[0]?.id ?? 'default';
  } catch {
    return 'default';
  }
}

export function resolveContextWindow(session: Session, activeModel: string): number | null {
  try {
    const provider = session.providers.getActive();
    const match = provider.models.find((m) => m.id === activeModel);
    return match?.contextWindow ?? provider.models[0]?.contextWindow ?? null;
  } catch {
    return null;
  }
}

export function buildSlashSuggestions(session: Session): ReadonlyArray<SlashCommand> {
  const fromRegistry: SlashCommand[] = session.commands
    .listForChannel('tui')
    .map((c: CommandDef) => ({
      name: c.name,
      description: c.description,
      ...(c.aliases ? { aliases: c.aliases } : {}),
    }));
  const seen = new Set(fromRegistry.map((c) => c.name));
  const tuiLocal = BUILTIN_SLASH_COMMANDS.filter((c) => !seen.has(c.name));
  return [...fromRegistry, ...tuiLocal].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveActiveDescriptor(
  session: Session,
  activeModel: string,
): { supportsImages?: boolean } | null {
  try {
    const provider = session.providers.getActive();
    return provider.models.find((m) => m.id === activeModel) ?? null;
  } catch {
    return null;
  }
}

export function getModeName(session: Session): string {
  try {
    return session.modes.getActive().name;
  } catch {
    return '(none)';
  }
}

export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/**
 * Group MCP tools (those prefixed `mcp__<server>__*`) by server name
 * for the SkillsPanel summary. Reads the live tool registry — only
 * servers whose tools are currently registered appear, so the section
 * reflects the actual catalog the model can call right now.
 */
export function deriveMcpServers(
  tools: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<{ name: string; toolCount: number; toolNames: ReadonlyArray<string> }> {
  const grouped = new Map<string, string[]>();
  for (const t of tools) {
    const m = /^mcp__([a-z0-9-]+)__/.exec(t.name);
    if (!m) continue;
    const server = m[1]!;
    const list = grouped.get(server) ?? [];
    list.push(t.name);
    grouped.set(server, list);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, toolNames]) => ({ name, toolCount: toolNames.length, toolNames }));
}

/**
 * Wipe the visible terminal AND its scrollback buffer.
 *
 * Why this is needed: `<Static>` items in Ink commit to the terminal's
 * scrollback once and stay there forever — Ink's render loop can't
 * reach up and erase already-printed lines. `/clear` and `/new` empty
 * the React state and the event log, but the historical text the user
 * already scrolled past remains in the terminal's history. Emitting
 * the ANSI sequence is the only way to truly start fresh.
 *
 *   \x1b[3J  — clear scrollback (xterm extension; widely supported)
 *   \x1b[2J  — clear visible viewport
 *   \x1b[H   — move cursor to home (0,0)
 *
 * Ink's next paint draws the (now-empty) chat + bottom UI cleanly.
 */
export function clearTerminalScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
  }
}
