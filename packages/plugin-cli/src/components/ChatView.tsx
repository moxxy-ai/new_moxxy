import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text } from 'ink';
import type {
  MoxxyEvent,
  SkillInvokedEvent,
  ToolCallRequestedEvent,
  ToolResultEvent,
} from '@moxxy/sdk';
import { Markdown } from './Markdown.js';
import { Colors, Glyphs } from '../theme.js';

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
  // The longest leading prefix of blocks whose contents will never
  // change again gets handed to <Static>. Ink renders each Static item
  // ONCE, appends it to the terminal scrollback, then skips it on every
  // subsequent frame — so the "live" area below stays small. That
  // matters because Ink's renderer takes a `clearTerminal` shortcut
  // whenever `outputHeight >= terminal rows`, and clearing+repainting
  // the whole screen at spinner/streaming-chunk rate is exactly the
  // multi-times-per-second "flashing" the user sees during tool calls.
  //
  // settledRef is append-only on purpose: Static caches by index, so
  // any previously-handed item is frozen. We only push blocks once
  // they're truly settled (tool call has an outcome, skill scope is
  // closed with all children settled, subagent has completed, etc.).
  const settledRef = useRef<Block[]>([]);
  const clearGenerationRef = useRef(0);
  // /clear and /new drop events back to []. settledRef still holds old
  // captures — detect the shrink, drop them, and bump a key so the
  // Static node fully remounts (its internal `index` resets).
  if (blocks.length < settledRef.current.length) {
    settledRef.current = [];
    clearGenerationRef.current += 1;
  }
  let settledCount = 0;
  for (const b of blocks) {
    if (isSettled(b)) settledCount += 1;
    else break;
  }
  if (settledCount > settledRef.current.length) {
    const next = settledRef.current.slice();
    for (let i = settledRef.current.length; i < settledCount; i += 1) {
      next.push(blocks[i]!);
    }
    settledRef.current = next;
  }
  const liveBlocks = blocks.slice(settledRef.current.length);
  return (
    <>
      <Static key={clearGenerationRef.current} items={settledRef.current}>
        {(block) => (
          <BlockLine key={block.id} block={block} expandClosedSkills={!!expandClosedSkills} />
        )}
      </Static>
      <Box flexDirection="column">
        {liveBlocks.map((b) => (
          <BlockLine key={b.id} block={b} expandClosedSkills={!!expandClosedSkills} />
        ))}
        {streamingDelta && streamingDelta.trim() ? (
          <AssistantBlock content={streamingDelta} />
        ) : null}
      </Box>
    </>
  );
};

/**
 * A block is "settled" once nothing in its render will change anymore.
 * Static-rendered items are frozen, so this gate must be conservative:
 * pending tool calls (animated dot), open skill scopes (children still
 * arriving), and running subagents (live elapsed counter) all stay in
 * the dynamic area until they finish.
 */
function isSettled(block: Block): boolean {
  if (block.kind === 'event') return true;
  if (block.kind === 'tool-call') return block.outcome !== null;
  if (block.kind === 'subagent') return block.completedAtMs !== null || block.error !== null;
  if (block.kind === 'skill-scope') {
    return block.closed && block.children.every(isSettled);
  }
  return true;
}

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
        <Text dimColor>{Glyphs.filled}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown content={content} firstBlockTight />
      </Box>
    </Box>
  );
};

type Block = EventBlock | ToolCallBlockData | SkillScopeBlock | SubagentBlock;

/**
 * Aggregated view of one spawned subagent. Built from the plugin_event
 * stream the SubagentSpawner emits: `subagent_started` opens it,
 * `subagent_tool_call` increments the tool counter, `subagent_completed`
 * stamps the final state. Rendered as a single dim row by default
 * (`◆ agent <label> · <state> Ns · N tool calls`) so a fleet of 5
 * agents takes 5 rows, not 50.
 */
interface SubagentBlock {
  kind: 'subagent';
  readonly id: string;
  readonly childSessionId: string;
  readonly label: string;
  readonly startedAtMs: number;
  /** ms timestamp of completion, or null while running. */
  completedAtMs: number | null;
  toolCallCount: number;
  /** stop reason for completed agents; populated on subagent_completed. */
  stopReason: string | null;
  /** First line of the agent's final assistant message — used as a one-line preview. */
  finalPreview: string | null;
  /** Error message if the agent failed (subagent_error/abort or non-OK stopReason). */
  error: string | null;
}

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

const SUBAGENT_PLUGIN_ID = '@moxxy/subagents';

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
  // Live subagent blocks keyed by their childSessionId so subsequent
  // tool-call / completed events from the spawner can attach to the
  // right block.
  const subagents = new Map<string, SubagentBlock>();

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
    if (e.type === 'assistant_message') {
      // Assistant messages always render at the chat's left margin,
      // even when a skill scope is open above them. The scope groups
      // skill tool work; the assistant's commentary surrounding that
      // work belongs at root so its bullet aligns with the rest of the
      // conversation — and so post-stream rendering matches the
      // streaming preview, which already lives at root.
      root.push({ kind: 'event', id: e.id, event: e });
      continue;
    }
    // Subagent events fold into one-line scope blocks so a fleet of
    // children doesn't drown the main chat. The SubagentSpawner emits
    // them as plugin_event with pluginId='@moxxy/subagents'.
    if (e.type === 'plugin_event' && e.pluginId === SUBAGENT_PLUGIN_ID) {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const childSessionId = String(payload.childSessionId ?? '');
      if (!childSessionId) continue;
      if (e.subtype === 'subagent_started') {
        const block: SubagentBlock = {
          kind: 'subagent',
          id: e.id,
          childSessionId,
          label: String(payload.label ?? 'agent'),
          startedAtMs: new Date(e.ts).getTime(),
          completedAtMs: null,
          toolCallCount: 0,
          stopReason: null,
          finalPreview: null,
          error: null,
        };
        subagents.set(childSessionId, block);
        pushBlock(block);
        continue;
      }
      const block = subagents.get(childSessionId);
      if (!block) continue;
      if (e.subtype === 'subagent_tool_call') {
        block.toolCallCount += 1;
        continue;
      }
      if (e.subtype === 'subagent_completed') {
        block.completedAtMs = new Date(e.ts).getTime();
        block.stopReason = String(payload.stopReason ?? '');
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text) block.finalPreview = oneLine(text);
        if (typeof payload.error === 'string') block.error = payload.error;
        continue;
      }
      if (e.subtype === 'subagent_error' || e.subtype === 'subagent_abort') {
        block.completedAtMs = new Date(e.ts).getTime();
        const reason =
          (typeof payload.message === 'string' && payload.message) ||
          (typeof payload.reason === 'string' && payload.reason) ||
          'aborted';
        block.error = reason;
        continue;
      }
      // chunk / tool_result / nested-grand-child: ignore at top level;
      // the /agents modal exposes the raw stream when needed.
      continue;
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
  if (block.kind === 'subagent') {
    return <SubagentScopeView scope={block} />;
  }
  return <SkillScopeView scope={block} expandClosedSkills={expandClosedSkills} />;
};

const SubagentScopeView: React.FC<{ scope: SubagentBlock }> = ({ scope }) => {
  const [now, setNow] = useState(() => Date.now());
  const running = scope.completedAtMs == null && scope.error == null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const endMs = scope.completedAtMs ?? now;
  const elapsed = formatElapsed(endMs - scope.startedAtMs);
  const toolPart = `${scope.toolCallCount} tool call${scope.toolCallCount === 1 ? '' : 's'}`;
  const dotColor = scope.error
    ? Colors.danger
    : running
      ? Colors.busy
      : DotColors.subagent;
  const state = scope.error ? 'failed' : running ? 'running' : 'done';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={dotColor}>{Glyphs.filled} </Text>
        <Text bold>{`agent `}</Text>
        <Text>{scope.label}</Text>
        <Text dimColor>{`  ${state} ${elapsed} · ${toolPart}`}</Text>
      </Box>
      {scope.error ? (
        <Box marginLeft={2}>
          <Text dimColor>└ </Text>
          <Text color={Colors.danger}>{truncate(scope.error, 100)}</Text>
        </Box>
      ) : scope.finalPreview && !running ? (
        <Box marginLeft={2}>
          <Text dimColor>{`└ ${truncate(scope.finalPreview, 100)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, '0')}s`;
}

const SkillScopeView: React.FC<{ scope: SkillScopeBlock; expandClosedSkills: boolean }> = ({
  scope,
  expandClosedSkills,
}) => {
  const childToolCount = countToolCalls(scope.children);
  const isExpanded = !scope.closed || expandClosedSkills;
  const callLabel = `skill · ${childToolCount} tool call${childToolCount === 1 ? '' : 's'}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={DotColors.skill}>{Glyphs.filled} </Text>
        <Text bold>{scope.skillEvent.name}</Text>
        <Text dimColor>{` (${callLabel})`}</Text>
        {scope.closed && !expandClosedSkills ? (
          <Text dimColor italic>{'  collapsed'}</Text>
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

/**
 * Color the `◆` indicator by where the call came from so a glance
 * across the scrollback shows which subsystem is active — MCP tools
 * are cyan, in-process skills magenta, builtin tools green, anything
 * else (compactor, abort, plugin notes) dim gray. Pending / failed
 * states override these (yellow / red).
 */
const DotColors = {
  mcp: 'cyan' as const,
  skill: 'magenta' as const,
  tool: 'green' as const,
  subagent: 'blue' as const,
  other: 'gray' as const,
};

function dotColorForTool(toolName: string): string {
  if (toolName.startsWith('mcp__')) return DotColors.mcp;
  return DotColors.tool;
}

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
const PendingBullet: React.FC = () => {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Text color={Colors.busy} dimColor={!on}>{Glyphs.filled}</Text>
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
  const argSummary = summarizeArgs(request.input);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {status === 'pending' ? (
          <PendingBullet />
        ) : status === 'err' ? (
          <Text color={Colors.danger}>{Glyphs.filled} </Text>
        ) : (
          <Text color={dotColorForTool(request.name)}>{Glyphs.filled} </Text>
        )}
        <Text bold>{request.name}</Text>
        <Text dimColor>{`(${argSummary})`}</Text>
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
    return <Text color={Colors.danger}>denied: {outcome.reason}</Text>;
  }
  if (!outcome.ok) {
    return (
      <Text color={Colors.danger}>
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
      // Highlighted echo bar: bold prompt glyph + the user text, then a
      // dim horizontal rule under it. Matches the Grok-style "pinned
      // user prompt" treatment without needing a full bordered box.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text>{`${Glyphs.prompt} `}</Text>
            <Text bold>{event.text}</Text>
          </Box>
          <Text dimColor>{'─'.repeat(Math.min(60, event.text.length + 2))}</Text>
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
          <Text dimColor>{Glyphs.filled} </Text>
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
          <Text dimColor>⤺ </Text>
          <Text dimColor>
            compacted {event.replacedRange[1] - event.replacedRange[0] + 1} events ({truncate(event.summary, 100)})
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={Colors.danger}>{Glyphs.filled} </Text>
          <Text color={Colors.danger}>error: </Text>
          <Text>{event.message}</Text>
        </Box>
      );
    case 'abort':
      return (
        <Box marginTop={1}>
          <Text color={Colors.busy}>⏹ aborted: {event.reason}</Text>
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
