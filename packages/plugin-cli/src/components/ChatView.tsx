import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  MoxxyEvent,
  SkillInvokedEvent,
  ToolCallRequestedEvent,
  ToolResultEvent,
} from '@moxxy/sdk';
import { Markdown } from './Markdown.js';

export interface ChatViewProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly streamingDelta?: string;
  /**
   * Override the per-skill expansion default. When `true`, every closed
   * skill scope renders expanded (children visible); when `false`, all
   * closed scopes collapse to a one-line summary. Defaults to false
   * (closed scopes collapse) — in-flight scopes ignore this and always
   * render expanded so the user can watch tools execute live.
   */
  readonly expandClosedSkills?: boolean;
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
export const ChatView: React.FC<ChatViewProps> = ({
  events,
  streamingDelta,
  expandClosedSkills,
}) => {
  const blocks = pairToolEvents(events);
  return (
    <Box flexDirection="column">
      {blocks.map((b) => (
        <BlockLine key={b.id} block={b} expandClosedSkills={!!expandClosedSkills} />
      ))}
      {streamingDelta && streamingDelta.trim() ? (
        <AssistantBlock content={streamingDelta} />
      ) : null}
    </Box>
  );
};

/**
 * Renders an assistant turn: a white `●` bullet on the first line and
 * the body rendered through the lightweight Markdown component
 * (headings, lists, code blocks, inline emphasis + links). Indented one
 * column past the bullet so the body reads as one visual unit attached
 * to its marker. Mirrors the Claude Code convention (white = assistant).
 */
const AssistantBlock: React.FC<{ content: string }> = ({ content }) => {
  if (!content.trim()) return null;
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexDirection="column" marginRight={1}>
        <Text color="white">●</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown content={content} firstBlockTight />
      </Box>
    </Box>
  );
};

type Block = EventBlock | ToolCallBlockData | SkillScopeBlock;

interface EventBlock {
  readonly kind: 'event';
  readonly id: string;
  readonly event: MoxxyEvent;
}

interface ToolCallBlockData {
  kind: 'tool-call';
  readonly id: string;
  readonly request: ToolCallRequestedEvent;
  outcome: ToolResultEvent | { type: 'denied'; reason: string } | null;
}

interface SkillScopeBlock {
  kind: 'skill-scope';
  readonly id: string;
  readonly skillEvent: SkillInvokedEvent;
  children: Block[];
  /**
   * A scope is "closed" once the turn ends (another user_prompt arrives
   * after it). Closed scopes collapse to a one-line summary by default;
   * in-flight scopes render expanded so the user can watch tools run.
   */
  closed: boolean;
}

function pairToolEvents(events: ReadonlyArray<MoxxyEvent>): Block[] {
  const root: Block[] = [];
  // Reverse lookup: callId → the tool-call block currently waiting on a
  // result/denied event. Lookup works whether the block sits in `root`
  // or inside an open skill scope.
  const callBlocks = new Map<string, ToolCallBlockData>();
  const suppressedCallIds = new Set<string>();
  let pendingLoadSkillCallId: string | null = null;
  // Active skill scope (children get pushed here instead of root).
  let openScope: SkillScopeBlock | null = null;

  const pushBlock = (block: Block): void => {
    if (openScope) {
      openScope.children.push(block);
    } else {
      root.push(block);
    }
  };

  const closeOpenScope = (): void => {
    if (openScope) {
      openScope.closed = true;
      openScope = null;
    }
  };

  // When a load_skill call has been pushed but the corresponding
  // skill_invoked hasn't arrived yet, we need to find and remove it
  // from wherever it landed (root or the previous scope's children).
  const removeBlockByCallId = (callId: string): void => {
    const removeFrom = (list: Block[]): boolean => {
      const idx = list.findIndex((b) => b.kind === 'tool-call' && b.request.callId === callId);
      if (idx >= 0) {
        list.splice(idx, 1);
        return true;
      }
      return false;
    };
    if (openScope && removeFrom(openScope.children)) return;
    removeFrom(root);
  };

  // UI safety net: when a new user_prompt arrives, any tool-call block
  // still showing `outcome: null` is an orphan — its result event never
  // landed. Mark it as a synthetic error so the dot stops pulsing forever
  // and the user can see *something* went wrong. The upstream loops should
  // synthesize tool_result events for these cases (and now do), but this
  // guard means a future regression can't leave a permanent stuck dot.
  const markOrphansAtTurnBoundary = (): void => {
    for (const block of callBlocks.values()) {
      if (block.outcome === null) {
        block.outcome = {
          type: 'denied',
          reason: 'no result recorded before next turn — likely interrupted or lost',
        };
      }
    }
    callBlocks.clear();
  };

  for (const e of events) {
    if (e.type === 'user_prompt') {
      closeOpenScope();
      markOrphansAtTurnBoundary();
      pendingLoadSkillCallId = null;
      root.push({ kind: 'event', id: e.id, event: e });
      continue;
    }
    if (e.type === 'skill_invoked') {
      // Close any previous scope, then open a new one. Also collapse
      // the load_skill tool-call into the new scope so we don't show
      // both "load_skill(name=foo)" AND "◆ skill: foo".
      closeOpenScope();
      if (pendingLoadSkillCallId) {
        suppressedCallIds.add(pendingLoadSkillCallId);
        removeBlockByCallId(pendingLoadSkillCallId);
        pendingLoadSkillCallId = null;
      }
      openScope = {
        kind: 'skill-scope',
        id: e.id,
        skillEvent: e,
        children: [],
        closed: false,
      };
      root.push(openScope);
      continue;
    }
    if (e.type === 'tool_call_requested') {
      if (e.name === 'load_skill') {
        pendingLoadSkillCallId = e.callId;
      }
      const block: ToolCallBlockData = {
        kind: 'tool-call',
        id: e.id,
        request: e,
        outcome: null,
      };
      callBlocks.set(e.callId, block);
      pushBlock(block);
      continue;
    }
    if (e.type === 'tool_result') {
      if (suppressedCallIds.has(e.callId)) continue;
      const block = callBlocks.get(e.callId);
      if (block) {
        block.outcome = e;
        continue;
      }
    }
    if (e.type === 'tool_call_denied') {
      if (suppressedCallIds.has(e.callId)) continue;
      const block = callBlocks.get(e.callId);
      if (block) {
        block.outcome = { type: 'denied', reason: e.reason };
        continue;
      }
    }
    if (e.type === 'tool_call_approved') {
      continue; // outcome already conveys this
    }
    pushBlock({ kind: 'event', id: e.id, event: e });
  }
  return root;
}

const BlockLine: React.FC<{ block: Block; expandClosedSkills: boolean }> = ({
  block,
  expandClosedSkills,
}) => {
  if (block.kind === 'event') return <EventLine event={block.event} />;
  if (block.kind === 'tool-call') {
    return <ToolCallBlock request={block.request} outcome={block.outcome} />;
  }
  return <SkillScopeView scope={block} expandClosedSkills={expandClosedSkills} />;
};

const SkillScopeView: React.FC<{ scope: SkillScopeBlock; expandClosedSkills: boolean }> = ({
  scope,
  expandClosedSkills,
}) => {
  const childToolCount = countToolCalls(scope.children);
  const isExpanded = !scope.closed || expandClosedSkills;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="magenta" bold>
          {isExpanded ? '▾ ' : '▸ '}
        </Text>
        <Text color="magenta" bold>
          skill
        </Text>
        <Text dimColor>:</Text>
        <Text bold>{` ${scope.skillEvent.name}`}</Text>
        <Text dimColor>{`  ·  ${childToolCount} tool call${childToolCount === 1 ? '' : 's'}`}</Text>
        {scope.closed && !expandClosedSkills ? (
          <Text dimColor italic>{'  (collapsed)'}</Text>
        ) : null}
      </Box>
      {isExpanded ? (
        <Box flexDirection="column" marginLeft={2}>
          {scope.children.map((c) => (
            <BlockLine key={c.id} block={c} expandClosedSkills={expandClosedSkills} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

function countToolCalls(blocks: ReadonlyArray<Block>): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'tool-call') n += 1;
    else if (b.kind === 'skill-scope') n += countToolCalls(b.children);
  }
  return n;
}

/**
 * Pulsing `●` for in-flight tool calls. Toggles between full color and
 * dim every ~500ms so the user can tell at a glance that work is still
 * happening — a static yellow dot was reading as "stuck" when a long
 * shell command was running. The trailing space lives outside the
 * dimmed Text so the dim ANSI attribute can't bleed onto the tool name
 * that follows (some terminals interpret the boundary loosely and the
 * whole row appeared to pulse).
 */
const PendingBullet: React.FC<{ color: string }> = ({ color }) => {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Text color={color} dimColor={!on}>●</Text>
      <Text> </Text>
    </>
  );
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
        {status === 'pending' ? (
          <PendingBullet color={bulletColor} />
        ) : (
          <Text color={bulletColor}>● </Text>
        )}
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
  const preview = oneLine(stringify(outcome.output));
  return <Text dimColor>{truncate(preview, 100)}</Text>;
};

// Hard cap on the full argument-summary string. Joining lots of fields
// (especially MCP tools with `query`, `user_intent`, `design_type`, …)
// produces a multi-line wrap that dwarfs the rest of the chat. Cap at
// one terminal line worth and let the model's full input live in the
// event log if anyone wants the gory detail.
const ARG_SUMMARY_MAX = 90;
const VALUE_MAX = 28;

function summarizeArgs(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return truncate(oneLine(input), 60);
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  const joined = entries.map(([k, v]) => `${k}=${formatValue(v)}`).join(', ');
  return truncate(oneLine(joined), ARG_SUMMARY_MAX);
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(truncate(oneLine(v), VALUE_MAX));
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    return truncate(oneLine(JSON.stringify(v)), VALUE_MAX);
  } catch {
    return '[…]';
  }
}

/** Replace newlines + tabs with a single space so multi-line values
 *  don't wrap the tool-call header across many rows. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/  +/g, ' ').trim();
}

const EventLine: React.FC<{ event: MoxxyEvent }> = ({ event }) => {
  switch (event.type) {
    case 'user_prompt':
      // Only top margin — the block below (assistant / tool) owns its
      // own top spacing, so a marginBottom here compounds to two blank
      // lines between the user prompt and the first response.
      return (
        <Box marginTop={1}>
          <Text backgroundColor="#262626">{` ${event.text} `}</Text>
        </Box>
      );
    case 'assistant_message':
      return <AssistantBlock content={event.content} />;
    case 'skill_invoked':
      // SkillScopeView owns this render; if we reach here it means the
      // event escaped grouping (defensive fallback only).
      return null;
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
