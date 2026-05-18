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
  readonly aliases?: ReadonlyArray<string>;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: 'exit', description: 'Quit the TUI', aliases: ['quit', 'q'] },
  {
    name: 'new',
    description: 'Start a fresh session — wipes conversation history (keeps model + loop choice)',
  },
  { name: 'clear', description: 'Clear the chat scrollback (events stay in the log)' },
  { name: 'tools', description: 'List the tools the active session can call' },
  { name: 'skills', description: 'List the discovered skills' },
  { name: 'model', description: 'Switch provider + model — opens a picker' },
  { name: 'loop', description: 'Switch loop strategy (tool-use / plan-execute / …)' },
  { name: 'mcp', description: 'Enable / disable / remove MCP servers' },
  {
    name: 'yolo',
    description: 'Toggle auto-approve mode — every tool call allowed without asking',
    aliases: ['auto-approve'],
  },
  { name: 'expand', description: 'Expand closed skill scopes so children show in the chat' },
  { name: 'collapse', description: 'Collapse closed skill scopes back to a one-line summary' },
  { name: 'queue', description: 'Show messages queued while the current turn is running' },
  { name: 'clear-queue', description: 'Drop all queued messages' },
  { name: 'help', description: 'Show this command list' },
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
    <Box flexDirection="column" marginTop={1}>
      {matches.map((m, i) => {
        const focused = i === cursor;
        return (
          <Box key={m.name}>
            <Text color={focused ? 'cyan' : 'gray'}>{focused ? '› ' : '  '}</Text>
            <Text color={focused ? 'cyan' : undefined}>/{m.name}</Text>
            <Text dimColor>  — {m.description}</Text>
          </Box>
        );
      })}
      <Text dimColor>  tab to complete · enter to send · esc to dismiss</Text>
    </Box>
  );
};
