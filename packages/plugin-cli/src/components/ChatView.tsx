import React from 'react';
import { Box, Text } from 'ink';
import type { MoxxyEvent, ToolCallRequestedEvent, ToolResultEvent } from '@moxxy/sdk';

export interface ChatViewProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly streamingDelta?: string;
}

/**
 * Renders the chat scrollback. Pairs `tool_call_requested` events with
 * their matching `tool_result` / `tool_call_denied` so each tool use
 * shows as a single block:
 *
 *   ● Tool(arg=value, arg=value)
 *     └ result summary OR error reason
 *
 * Matches the visual rhythm of Claude Code's tool-use rendering.
 */
export const ChatView: React.FC<ChatViewProps> = ({ events, streamingDelta }) => {
  const blocks = pairToolEvents(events);
  return (
    <Box flexDirection="column">
      {blocks.map((b) => (
        <BlockLine key={b.id} block={b} />
      ))}
      {streamingDelta ? <AssistantBlock content={streamingDelta} /> : null}
    </Box>
  );
};

/**
 * Renders an assistant turn: a white `● ` bullet on the first line, the
 * response body in normal text, vertical padding above and below so it
 * breathes against tool blocks and the next user prompt. Mirrors the
 * Claude Code rendering convention (white = the assistant speaking).
 */
const AssistantBlock: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {lines.map((line, i) => (
        <Box key={i}>
          {i === 0 ? <Text color="white">● </Text> : <Text>  </Text>}
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
};

type Block =
  | { kind: 'event'; id: string; event: MoxxyEvent }
  | {
      kind: 'tool-call';
      id: string;
      request: ToolCallRequestedEvent;
      outcome: ToolResultEvent | { type: 'denied'; reason: string } | null;
    };

function pairToolEvents(events: ReadonlyArray<MoxxyEvent>): Block[] {
  const blocks: Block[] = [];
  const callIndex = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'tool_call_requested') {
      const block: Block = { kind: 'tool-call', id: e.id, request: e, outcome: null };
      callIndex.set(e.callId, blocks.length);
      blocks.push(block);
      continue;
    }
    if (e.type === 'tool_result') {
      const idx = callIndex.get(e.callId);
      if (idx !== undefined) {
        const block = blocks[idx]!;
        if (block.kind === 'tool-call') block.outcome = e;
        continue;
      }
    }
    if (e.type === 'tool_call_denied') {
      const idx = callIndex.get(e.callId);
      if (idx !== undefined) {
        const block = blocks[idx]!;
        if (block.kind === 'tool-call') block.outcome = { type: 'denied', reason: e.reason };
        continue;
      }
    }
    if (e.type === 'tool_call_approved') {
      // Approved events are noise next to the result — the outcome block
      // already conveys the same information.
      continue;
    }
    blocks.push({ kind: 'event', id: e.id, event: e });
  }
  return blocks;
}

const BlockLine: React.FC<{ block: Block }> = ({ block }) => {
  if (block.kind === 'event') return <EventLine event={block.event} />;
  return <ToolCallBlock request={block.request} outcome={block.outcome} />;
};

const ToolCallBlock: React.FC<{
  request: ToolCallRequestedEvent;
  outcome: ToolResultEvent | { type: 'denied'; reason: string } | null;
}> = ({ request, outcome }) => {
  const status: 'pending' | 'ok' | 'err' =
    outcome === null
      ? 'pending'
      : outcome.type === 'denied'
        ? 'err'
        : outcome.ok
          ? 'ok'
          : 'err';
  const bulletColor = status === 'pending' ? 'yellow' : status === 'ok' ? 'green' : 'red';
  const argSummary = summarizeArgs(request.input);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={bulletColor}>● </Text>
        <Text bold>{request.name}</Text>
        <Text>(</Text>
        <Text dimColor>{argSummary}</Text>
        <Text>)</Text>
      </Box>
      {outcome ? (
        <Box>
          <Text dimColor>  └ </Text>
          <OutcomeText outcome={outcome} />
        </Box>
      ) : null}
    </Box>
  );
};

const OutcomeText: React.FC<{
  outcome: ToolResultEvent | { type: 'denied'; reason: string };
}> = ({ outcome }) => {
  if (outcome.type === 'denied') {
    return <Text color="red">denied: {outcome.reason}</Text>;
  }
  if (!outcome.ok) {
    return (
      <Text color="red">
        {outcome.error?.kind ?? 'error'}: {outcome.error?.message}
      </Text>
    );
  }
  const preview = stringify(outcome.output);
  return <Text dimColor>{truncate(preview, 120)}</Text>;
};

function summarizeArgs(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return truncate(input, 60);
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${formatValue(v)}`).join(', ');
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(truncate(v, 40));
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    return truncate(JSON.stringify(v), 40);
  } catch {
    return '[…]';
  }
}

const EventLine: React.FC<{ event: MoxxyEvent }> = ({ event }) => {
  switch (event.type) {
    case 'user_prompt':
      return (
        <Box marginTop={1} marginBottom={1}>
          <Text color="blue" bold>{'> '}</Text>
          <Text>{event.text}</Text>
        </Box>
      );
    case 'assistant_message':
      return <AssistantBlock content={event.content} />;
    case 'skill_created':
      return (
        <Box marginTop={1}>
          <Text color="green">● </Text>
          <Text bold>skill created</Text>
          <Text dimColor>  {event.name}</Text>
        </Box>
      );
    case 'plugin_registered':
      return (
        <Box>
          <Text dimColor>  + plugin: {event.name}@{event.version}</Text>
        </Box>
      );
    case 'compaction':
      return (
        <Box marginTop={1}>
          <Text color="magenta">⤺ </Text>
          <Text dimColor>
            compacted {event.replacedRange[1] - event.replacedRange[0] + 1} events ({truncate(event.summary, 100)})
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="red">● </Text>
          <Text color="red">error: </Text>
          <Text>{event.message}</Text>
        </Box>
      );
    case 'abort':
      return (
        <Box marginTop={1}>
          <Text color="yellow">⏹ aborted: {event.reason}</Text>
        </Box>
      );
    default:
      return null;
  }
};

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
