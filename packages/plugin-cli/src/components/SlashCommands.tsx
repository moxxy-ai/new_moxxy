import React from 'react';
import { Box, Text } from 'ink';

/**
 * In-TUI slash commands. The list is shown as an autocomplete dropdown
 * when the user's input starts with `/`. Each command is a label + action
 * the InteractiveSession knows how to handle.
 */
export interface SlashCommand {
  readonly name: string;          // without leading `/`
  readonly description: string;
  /** Usage hint for args, e.g. `set <key> <value>` — shown as ghost text. */
  readonly argumentHint?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/**
 * Channel-local commands that ONLY make sense in the Ink TUI — they
 * either open an overlay picker (model / loop / mcp / tools / skills /
 * agents) or mutate raw React state (yolo, queue controls). The TUI
 * merges this list with `session.commands` so the autocomplete
 * dropdown lists everything together.
 *
 * Universal commands like /info, /clear, /new, /exit, /help live in
 * `@moxxy/plugin-commands` and are inherited by every channel.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: 'tools', description: 'List the tools the active session can call' },
  { name: 'skills', description: 'List the discovered skills' },
  { name: 'agents', description: 'Inspect spawned subagents and their activity' },
  { name: 'usage', description: 'Show session token usage, cache savings, and per-call trend' },
  { name: 'model', description: 'Switch provider + model — opens a picker' },
  {
    name: 'mode',
    description: 'Switch mode (tool-use / plan-execute / bmad)',
    argumentHint: '[mode]',
    aliases: ['loop'],
  },
  { name: 'mcp', description: 'Enable / disable / remove MCP servers' },
  {
    name: 'yolo',
    description: 'Toggle auto-approve mode — every tool call allowed without asking',
    aliases: ['auto-approve'],
  },
  { name: 'queue', description: 'Show messages queued while the current turn is running' },
  { name: 'clear-queue', description: 'Drop all queued messages' },
];

/**
 * Match a partial slash query (e.g. `/ex`) against the command list.
 * Returns up to `limit` entries, ordered by:
 *   1. exact `name` match
 *   2. prefix match on `name`
 *   3. prefix match on an alias
 */
export function matchSlash(
  query: string,
  commands: ReadonlyArray<SlashCommand> = BUILTIN_SLASH_COMMANDS,
  limit = 8,
): SlashCommand[] {
  if (!query.startsWith('/')) return [];
  const needle = query.slice(1).toLowerCase();
  if (needle === '') return [...commands].slice(0, limit);
  const exact: SlashCommand[] = [];
  const prefix: SlashCommand[] = [];
  const alias: SlashCommand[] = [];
  for (const c of commands) {
    if (c.name === needle) exact.push(c);
    else if (c.name.startsWith(needle)) prefix.push(c);
    else if (c.aliases?.some((a) => a.startsWith(needle))) alias.push(c);
  }
  return [...exact, ...prefix, ...alias].slice(0, limit);
}

/**
 * Inline autocomplete dropdown rendered above the prompt input when the
 * buffer starts with `/`. `cursor` is the index of the highlighted entry.
 */
export const SlashSuggestions: React.FC<{
  matches: ReadonlyArray<SlashCommand>;
  cursor: number;
}> = ({ matches, cursor }) => {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column">
      {matches.map((m, i) => {
        const focused = i === cursor;
        return (
          <Box key={m.name}>
            <Text {...(focused ? {} : { dimColor: true })}>{focused ? '› ' : '  '}</Text>
            <Text {...(focused ? { bold: true } : { dimColor: true })}>/{m.name}</Text>
            <Text dimColor>{`  — ${m.description}`}</Text>
          </Box>
        );
      })}
      <Text dimColor>  tab to complete · enter to send · esc to dismiss</Text>
    </Box>
  );
};
