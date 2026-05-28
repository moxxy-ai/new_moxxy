import { describe, expect, it } from 'vitest';
import {
  asEventId,
  asPluginId,
  asSessionId,
  asSkillId,
  asToolCallId,
  asTurnId,
  type AssistantMessageEvent,
  type MoxxyEvent,
  type PluginEvent,
  type SkillInvokedEvent,
  type ToolCallDeniedEvent,
  type ToolCallRequestedEvent,
  type ToolCompactPresentation,
  type ToolResultEvent,
  type UserPromptEvent,
} from '@moxxy/sdk';
import {
  blocksEquivalent,
  countToolCalls,
  isSettled,
  pairToolEvents,
  type CompactToolMap,
} from './pair-events.js';
import type { LiveToolBlockData, SkillScopeBlock, SubagentBlock, ToolCallBlockData } from './types.js';

// ---------------------------------------------------------------------------
// Synthetic-event builders. Each returns a fully-typed MoxxyEvent so we drive
// `pairToolEvents` exactly the way the channel does — no `as any` shortcuts.
// `seq` is auto-incremented so ordering is realistic; the aggregator itself
// keys off insertion order, not seq, so the exact values don't matter.
// ---------------------------------------------------------------------------

let seq = 0;
const base = () => {
  seq += 1;
  return {
    id: asEventId(`e${seq}`),
    seq,
    ts: seq * 1000,
    sessionId: asSessionId('s1'),
    turnId: asTurnId('t1'),
  } as const;
};

const userPrompt = (text: string): UserPromptEvent => ({
  ...base(),
  type: 'user_prompt',
  source: 'user',
  text,
});

const toolRequest = (callId: string, name: string, input: unknown = {}): ToolCallRequestedEvent => ({
  ...base(),
  type: 'tool_call_requested',
  source: 'model',
  callId: asToolCallId(callId),
  name,
  input,
});

const toolResult = (callId: string, output: unknown = 'ok', ok = true): ToolResultEvent => ({
  ...base(),
  type: 'tool_result',
  source: 'tool',
  callId: asToolCallId(callId),
  ok,
  output,
});

const toolDenied = (callId: string, reason: string): ToolCallDeniedEvent => ({
  ...base(),
  type: 'tool_call_denied',
  source: 'plugin',
  callId: asToolCallId(callId),
  decidedBy: 'resolver',
  reason,
});

const skillInvoked = (skillId: string, name: string): SkillInvokedEvent => ({
  ...base(),
  type: 'skill_invoked',
  source: 'system',
  skillId: asSkillId(skillId),
  name,
  reason: 'manual',
});

const assistantMessage = (content: string): AssistantMessageEvent => ({
  ...base(),
  type: 'assistant_message',
  source: 'model',
  content,
  stopReason: 'end_turn',
});

const SUBAGENT_PLUGIN_ID = '@moxxy/subagents';
const subagentEvent = (subtype: string, payload: Record<string, unknown>): PluginEvent => ({
  ...base(),
  type: 'plugin_event',
  source: 'plugin',
  pluginId: asPluginId(SUBAGENT_PLUGIN_ID),
  subtype,
  payload,
});

// A compact-tool presentation map for the live-aggregation branch.
const readCompact: ToolCompactPresentation = {
  verb: 'Reading',
  noun: { one: 'file', other: 'files' },
  previewKey: 'file_path',
};
const grepCompact: ToolCompactPresentation = {
  verb: 'Searching for',
  noun: { one: 'pattern', other: 'patterns' },
};
const compactMap: CompactToolMap = new Map([
  ['read', readCompact],
  ['grep', grepCompact],
]);

// Type-narrowing helpers so assertions stay readable + typesafe.
const asToolCall = (b: unknown): ToolCallBlockData => {
  const block = b as ToolCallBlockData;
  expect(block.kind).toBe('tool-call');
  return block;
};
const asScope = (b: unknown): SkillScopeBlock => {
  const block = b as SkillScopeBlock;
  expect(block.kind).toBe('skill-scope');
  return block;
};
const asLive = (b: unknown): LiveToolBlockData => {
  const block = b as LiveToolBlockData;
  expect(block.kind).toBe('live-tools');
  return block;
};
const asSubagent = (b: unknown): SubagentBlock => {
  const block = b as SubagentBlock;
  expect(block.kind).toBe('subagent');
  return block;
};

describe('pairToolEvents — verbose tool pairing', () => {
  it('pairs a tool_call_requested with its tool_result into one settled block', () => {
    const events: MoxxyEvent[] = [
      toolRequest('c1', 'bash', { command: 'ls' }),
      toolResult('c1', 'file-a\nfile-b'),
    ];
    const blocks = pairToolEvents(events);

    expect(blocks).toHaveLength(1);
    const tc = asToolCall(blocks[0]);
    expect(tc.request.name).toBe('bash');
    expect(tc.outcome).not.toBeNull();
    expect(tc.outcome).toMatchObject({ type: 'tool_result', ok: true });
    expect(isSettled(tc)).toBe(true);
    expect(countToolCalls(blocks)).toBe(1);
  });

  it('folds a tool_call_denied into a denied outcome', () => {
    const blocks = pairToolEvents([
      toolRequest('c1', 'bash', { command: 'rm -rf /' }),
      toolDenied('c1', 'blocked by policy'),
    ]);
    const tc = asToolCall(blocks[0]);
    expect(tc.outcome).toEqual({ type: 'denied', reason: 'blocked by policy' });
    expect(isSettled(tc)).toBe(true);
  });

  it('leaves an unresolved tool call pending (outcome null, not settled)', () => {
    const blocks = pairToolEvents([toolRequest('c1', 'bash')]);
    const tc = asToolCall(blocks[0]);
    expect(tc.outcome).toBeNull();
    expect(isSettled(tc)).toBe(false);
  });
});

describe('pairToolEvents — orphan tool call at a turn boundary', () => {
  it('synthesizes a denied/interrupted outcome when a new user_prompt arrives', () => {
    // c1 never gets a result; the next user_prompt should mark it as an
    // interrupted orphan rather than leaving a forever-pulsing block.
    const blocks = pairToolEvents([
      userPrompt('do a thing'),
      toolRequest('c1', 'bash', { command: 'sleep 999' }),
      userPrompt('actually never mind'),
    ]);

    // event(prompt) + tool-call + event(prompt)
    expect(blocks).toHaveLength(3);
    const tc = asToolCall(blocks[1]);
    expect(tc.outcome).not.toBeNull();
    expect(tc.outcome).toMatchObject({ type: 'denied' });
    expect((tc.outcome as { type: 'denied'; reason: string }).reason).toMatch(/interrupted|lost/i);
    // The orphan is now settled — the dot stops pulsing.
    expect(isSettled(tc)).toBe(true);
  });

  it('does NOT touch a call that resolved before the boundary', () => {
    const blocks = pairToolEvents([
      toolRequest('c1', 'bash'),
      toolResult('c1', 'done'),
      userPrompt('next'),
    ]);
    const tc = asToolCall(blocks[0]);
    expect(tc.outcome).toMatchObject({ type: 'tool_result' });
  });

  it('does not resurrect an orphan when its result lands AFTER the boundary', () => {
    // Once cleared at the boundary, a late tool_result for that callId has no
    // target and is rendered as a bare event rather than re-opening the call.
    const blocks = pairToolEvents([
      toolRequest('c1', 'bash'),
      userPrompt('next'),
      toolResult('c1', 'too late'),
    ]);
    const tc = asToolCall(blocks[0]);
    expect(tc.outcome).toMatchObject({ type: 'denied' });
    // The late result falls through to a generic event block.
    const last = blocks[blocks.length - 1];
    expect(last.kind).toBe('event');
  });
});

describe('pairToolEvents — skill grouping', () => {
  it('groups tool calls under an open skill scope', () => {
    const blocks = pairToolEvents([
      skillInvoked('sk1', 'pdf'),
      toolRequest('c1', 'bash'),
      toolResult('c1'),
      toolRequest('c2', 'write'),
      toolResult('c2'),
    ]);

    expect(blocks).toHaveLength(1);
    const scope = asScope(blocks[0]);
    expect(scope.skillEvent.name).toBe('pdf');
    expect(scope.children).toHaveLength(2);
    expect(scope.children.every((c) => c.kind === 'tool-call')).toBe(true);
    // Open scope is not closed/settled until a turn boundary closes it.
    expect(scope.closed).toBe(false);
    expect(isSettled(scope)).toBe(false);
    // countToolCalls recurses into scope children.
    expect(countToolCalls(blocks)).toBe(2);
  });

  it('suppresses the load_skill tool call and collapses it into the scope', () => {
    const blocks = pairToolEvents([
      toolRequest('ls1', 'load_skill', { name: 'pdf' }),
      skillInvoked('sk1', 'pdf'),
      toolRequest('c1', 'bash'),
      toolResult('c1'),
    ]);

    // The load_skill tool-call must NOT appear as its own block.
    expect(blocks).toHaveLength(1);
    const scope = asScope(blocks[0]);
    expect(scope.children).toHaveLength(1);
    expect(asToolCall(scope.children[0]).request.name).toBe('bash');

    // A late tool_result for the suppressed load_skill is dropped, not rendered.
    const withResult = pairToolEvents([
      toolRequest('ls1', 'load_skill', { name: 'pdf' }),
      skillInvoked('sk1', 'pdf'),
      toolResult('ls1', 'loaded'),
    ]);
    const scope2 = asScope(withResult[0]);
    expect(scope2.children).toHaveLength(0);
  });

  it('splits an interleaved assistant_message to the left margin and opens a continuation scope', () => {
    const blocks = pairToolEvents([
      skillInvoked('sk1', 'pdf'),
      toolRequest('c1', 'bash'),
      toolResult('c1'),
      assistantMessage('Now generating the PDF…'),
      toolRequest('c2', 'write'),
      toolResult('c2'),
    ]);

    // scope(closed) + event(assistant) + continuation-scope
    expect(blocks).toHaveLength(3);

    const firstScope = asScope(blocks[0]);
    expect(firstScope.closed).toBe(true);
    expect(firstScope.children).toHaveLength(1);
    expect(isSettled(firstScope)).toBe(true);

    expect(blocks[1].kind).toBe('event');

    const contScope = asScope(blocks[2]);
    // Continuation carries the SAME skill event through to the grouping.
    expect(contScope.skillEvent).toBe(firstScope.skillEvent);
    expect(contScope.children).toHaveLength(1);
    expect(asToolCall(contScope.children[0]).request.name).toBe('write');

    // Both scopes' calls counted across the split.
    expect(countToolCalls(blocks)).toBe(2);
  });

  it('closes the scope at a turn boundary so it becomes settled', () => {
    const blocks = pairToolEvents([
      skillInvoked('sk1', 'pdf'),
      toolRequest('c1', 'bash'),
      toolResult('c1'),
      userPrompt('thanks'),
    ]);
    const scope = asScope(blocks[0]);
    expect(scope.closed).toBe(true);
    expect(isSettled(scope)).toBe(true);
  });
});

describe('pairToolEvents — compact-tool live aggregation', () => {
  it('aggregates consecutive compact calls into one live block', () => {
    const blocks = pairToolEvents(
      [
        toolRequest('c1', 'read', { file_path: '/a.ts' }),
        toolResult('c1'),
        toolRequest('c2', 'read', { file_path: '/b.ts' }),
        toolResult('c2'),
        toolRequest('c3', 'grep', { pattern: 'foo' }),
        toolResult('c3'),
      ],
      compactMap,
    );

    expect(blocks).toHaveLength(1);
    const live = asLive(blocks[0]);
    expect(live.calls).toHaveLength(3);
    expect(live.calls.map((c) => c.request.name)).toEqual(['read', 'read', 'grep']);
    expect(live.calls.every((c) => c.outcome !== null)).toBe(true);
    // Still open (no closing event) → not settled even though all resolved.
    expect(live.closed).toBe(false);
    expect(isSettled(live)).toBe(false);
    // countToolCalls counts every call in the live block.
    expect(countToolCalls(blocks)).toBe(3);
  });

  it('seals the live block when a verbose tool call interrupts', () => {
    const blocks = pairToolEvents(
      [
        toolRequest('c1', 'read', { file_path: '/a.ts' }),
        toolResult('c1'),
        toolRequest('c2', 'bash', { command: 'ls' }), // verbose → closes live
        toolResult('c2'),
        toolRequest('c3', 'read', { file_path: '/c.ts' }), // new live block
        toolResult('c3'),
      ],
      compactMap,
    );

    // live(closed) + tool-call(bash) + live(open)
    expect(blocks).toHaveLength(3);
    const firstLive = asLive(blocks[0]);
    expect(firstLive.closed).toBe(true);
    expect(firstLive.calls).toHaveLength(1);
    expect(isSettled(firstLive)).toBe(true);

    expect(asToolCall(blocks[1]).request.name).toBe('bash');

    const secondLive = asLive(blocks[2]);
    expect(secondLive.closed).toBe(false);
    expect(secondLive.calls).toHaveLength(1);
    expect(countToolCalls(blocks)).toBe(3);
  });

  it('seals the live block on an assistant_message', () => {
    const blocks = pairToolEvents(
      [
        toolRequest('c1', 'read', { file_path: '/a.ts' }),
        toolResult('c1'),
        assistantMessage('found it'),
      ],
      compactMap,
    );
    expect(blocks).toHaveLength(2);
    const live = asLive(blocks[0]);
    expect(live.closed).toBe(true);
    expect(isSettled(live)).toBe(true);
    expect(blocks[1].kind).toBe('event');
  });
});

describe('pairToolEvents — subagent lifecycle accretion', () => {
  it('accretes start → tool_call → completed into one subagent block', () => {
    const blocks = pairToolEvents([
      subagentEvent('subagent_started', { childSessionId: 'cs1', label: 'researcher' }),
      subagentEvent('subagent_tool_call', { childSessionId: 'cs1' }),
      subagentEvent('subagent_tool_call', { childSessionId: 'cs1' }),
      subagentEvent('subagent_completed', {
        childSessionId: 'cs1',
        stopReason: 'end_turn',
        text: 'Here is the\nfinal answer',
      }),
    ]);

    expect(blocks).toHaveLength(1);
    const sub = asSubagent(blocks[0]);
    expect(sub.label).toBe('researcher');
    expect(sub.toolCallCount).toBe(2);
    expect(sub.stopReason).toBe('end_turn');
    expect(sub.completedAtMs).not.toBeNull();
    expect(sub.finalPreview).toBe('Here is the final answer');
    expect(sub.error).toBeNull();
    expect(isSettled(sub)).toBe(true);
  });

  it('marks a running subagent as not settled until it completes', () => {
    const blocks = pairToolEvents([
      subagentEvent('subagent_started', { childSessionId: 'cs1', label: 'agent' }),
      subagentEvent('subagent_tool_call', { childSessionId: 'cs1' }),
    ]);
    const sub = asSubagent(blocks[0]);
    expect(sub.completedAtMs).toBeNull();
    expect(isSettled(sub)).toBe(false);
  });

  it('records an error from subagent_error and settles', () => {
    const blocks = pairToolEvents([
      subagentEvent('subagent_started', { childSessionId: 'cs1', label: 'agent' }),
      subagentEvent('subagent_error', { childSessionId: 'cs1', message: 'boom' }),
    ]);
    const sub = asSubagent(blocks[0]);
    expect(sub.error).toBe('boom');
    expect(sub.completedAtMs).not.toBeNull();
    expect(isSettled(sub)).toBe(true);
  });

  it('ignores subagent events with no matching started block', () => {
    const blocks = pairToolEvents([subagentEvent('subagent_tool_call', { childSessionId: 'ghost' })]);
    expect(blocks).toHaveLength(0);
  });
});

describe('blocksEquivalent', () => {
  it('returns true for identical references (fast path)', () => {
    const [block] = pairToolEvents([toolRequest('c1', 'bash'), toolResult('c1')]);
    expect(blocksEquivalent(block!, block!)).toBe(true);
  });

  it('returns false across different kinds', () => {
    const tc = asToolCall(pairToolEvents([toolRequest('c1', 'bash')])[0]);
    const ev = pairToolEvents([userPrompt('hi')])[0]!;
    expect(blocksEquivalent(tc, ev)).toBe(false);
  });

  it('tool-call: equivalent when request+outcome refs match, different when outcome changes', () => {
    const req = toolRequest('c1', 'bash');
    const res = toolResult('c1');
    const pending = pairToolEvents([req])[0]!;
    const settled = pairToolEvents([req, res])[0]!;
    // Same request ref, different outcome (null vs result) → not equivalent.
    expect(blocksEquivalent(pending, settled)).toBe(false);

    // Two independent folds of the same events: equal field refs → equivalent.
    const a = pairToolEvents([req, res])[0]!;
    const b = pairToolEvents([req, res])[0]!;
    expect(blocksEquivalent(a, b)).toBe(true);
  });

  it('skill-scope: differs when closed flag or child count differs', () => {
    const sk = skillInvoked('sk1', 'pdf');
    const c1 = toolRequest('c1', 'bash');
    const r1 = toolResult('c1');

    const openScope = asScope(pairToolEvents([sk, c1, r1])[0]);
    const closedScope = asScope(pairToolEvents([sk, c1, r1, userPrompt('x')])[0]);
    expect(openScope.closed).toBe(false);
    expect(closedScope.closed).toBe(true);
    expect(blocksEquivalent(openScope, closedScope)).toBe(false);

    const oneChild = asScope(pairToolEvents([sk, c1, r1])[0]);
    const twoChildren = asScope(
      pairToolEvents([sk, c1, r1, toolRequest('c2', 'write'), toolResult('c2')])[0],
    );
    expect(blocksEquivalent(oneChild, twoChildren)).toBe(false);

    // Same shape from the same inputs → equivalent (deep child compare).
    const x = asScope(pairToolEvents([sk, c1, r1])[0]);
    const y = asScope(pairToolEvents([sk, c1, r1])[0]);
    expect(blocksEquivalent(x, y)).toBe(true);
  });

  it('live-tools: differs when a call outcome ref differs', () => {
    const c1 = toolRequest('c1', 'read', { file_path: '/a.ts' });
    const r1 = toolResult('c1');
    const pending = asLive(pairToolEvents([c1], compactMap)[0]);
    const resolved = asLive(pairToolEvents([c1, r1], compactMap)[0]);
    expect(blocksEquivalent(pending, resolved)).toBe(false);

    const a = asLive(pairToolEvents([c1, r1], compactMap)[0]);
    const b = asLive(pairToolEvents([c1, r1], compactMap)[0]);
    expect(blocksEquivalent(a, b)).toBe(true);
  });

  it('subagent: differs on toolCallCount / completion / error', () => {
    const start = subagentEvent('subagent_started', { childSessionId: 'cs1', label: 'a' });
    const oneCall = asSubagent(pairToolEvents([start, subagentEvent('subagent_tool_call', { childSessionId: 'cs1' })])[0]);
    const twoCalls = asSubagent(
      pairToolEvents([
        start,
        subagentEvent('subagent_tool_call', { childSessionId: 'cs1' }),
        subagentEvent('subagent_tool_call', { childSessionId: 'cs1' }),
      ])[0],
    );
    expect(blocksEquivalent(oneCall, twoCalls)).toBe(false);
  });
});

describe('countToolCalls — mixed tree', () => {
  it('sums verbose calls, scope children, and live-block calls', () => {
    const blocks = pairToolEvents(
      [
        toolRequest('v1', 'bash'), // verbose, root
        toolResult('v1'),
        skillInvoked('sk1', 'pdf'),
        toolRequest('s1', 'write'), // scope child
        toolResult('s1'),
        userPrompt('next'), // close scope
        toolRequest('r1', 'read', { file_path: '/a.ts' }), // live x2
        toolResult('r1'),
        toolRequest('r2', 'read', { file_path: '/b.ts' }),
        toolResult('r2'),
      ],
      compactMap,
    );
    // 1 verbose + 1 scope-child + 2 live = 4.
    expect(countToolCalls(blocks)).toBe(4);
  });
});
