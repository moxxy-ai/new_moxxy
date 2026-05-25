import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@moxxy/sdk';
import { collectTurn } from '@moxxy/core';
import { FakeProvider, createFakeSession, textReply, toolUseReply } from '@moxxy/testing';
import { parsePlan, planExecuteModePlugin, PLAN_EXECUTE_MODE_NAME } from './index.js';

const PLAN_REPLY = textReply('PLAN:\n1. Read the config file.\n2. Report the version field.');

describe('parsePlan', () => {
  it('extracts numbered steps after a PLAN: header', () => {
    expect(parsePlan('PLAN:\n1. step a\n2. step b\n3. step c')).toEqual(['step a', 'step b', 'step c']);
  });

  it('also accepts dashes and bullets', () => {
    expect(parsePlan('PLAN:\n- alpha\n* beta\n- gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns empty array when no steps are present', () => {
    expect(parsePlan('I will think about it.')).toEqual([]);
  });

  it('tolerates parenthesized numbering "1)"', () => {
    expect(parsePlan('1) one\n2) two')).toEqual(['one', 'two']);
  });
});

describe('planExecuteMode end-to-end', () => {
  it('produces a plan, then executes each step via tool calls', async () => {
    const provider = new FakeProvider({
      script: [
        PLAN_REPLY,
        toolUseReply('Read', { file_path: '/etc/config' }, 'c1'),
        textReply('step 1 done'),
        textReply('Version is 1.2.3'),
      ],
    });

    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(planExecuteModePlugin);
    session.modes.setActive(PLAN_EXECUTE_MODE_NAME);
    session.tools.register(
      defineTool({
        name: 'Read',
        description: 'read file',
        inputSchema: z.object({ file_path: z.string() }),
        handler: () => 'version=1.2.3',
      }),
    );

    const events = await collectTurn(session, 'check the config version');

    const planCreated = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'plan_created',
    );
    expect(planCreated).toBeDefined();
    if (planCreated?.type !== 'plugin_event') throw new Error();
    const payload = planCreated.payload as { steps: string[] };
    expect(payload.steps).toHaveLength(2);

    const stepStarts = events.filter(
      (e) => e.type === 'plugin_event' && e.subtype === 'plan_step_started',
    );
    expect(stepStarts).toHaveLength(2);

    const completed = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'plan_completed',
    );
    expect(completed).toBeDefined();

    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBe('version=1.2.3');
  });

  it('aborts cleanly when no plan steps are extracted', async () => {
    const provider = new FakeProvider({
      script: [textReply('I am thinking but produced no plan.')],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(planExecuteModePlugin);
    session.modes.setActive(PLAN_EXECUTE_MODE_NAME);

    const events = await collectTurn(session, 'do something');

    const planCreated = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'plan_created',
    );
    expect(planCreated).toBeDefined();
    const completed = events.find(
      (e) => e.type === 'plugin_event' && e.subtype === 'plan_completed',
    );
    expect(completed).toBeUndefined();

    // The strategy still emits the planning text as an assistant_message for visibility
    const finalAssistant = events.filter((e) => e.type === 'assistant_message').pop();
    expect(finalAssistant?.type).toBe('assistant_message');
  });

  it('proves the loop contract is fungible — same Session, swap strategy, different shape', async () => {
    const provider = new FakeProvider({
      script: [
        PLAN_REPLY,
        textReply('all done step 1'),
        textReply('all done step 2'),
      ],
    });
    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(planExecuteModePlugin);
    session.modes.setActive(PLAN_EXECUTE_MODE_NAME);

    const events = await collectTurn(session, 'do x');
    const planEvents = events.filter((e) => e.type === 'plugin_event');
    expect(planEvents.map((e) => e.type === 'plugin_event' && e.subtype)).toContain('plan_created');
    expect(planEvents.map((e) => e.type === 'plugin_event' && e.subtype)).toContain('plan_completed');

    // Same Session+Provider could have run tool-use loop instead — only the strategy registration differs.
  });

  it('fires plugin onToolCall hooks before executing (parity with loop-tool-use)', async () => {
    // Regression: plan-execute used to skip the onToolCall hook entirely,
    // so plugin gating was silently disabled for plan-execute strategies.
    const provider = new FakeProvider({
      script: [
        // Single-step plan keeps the test small.
        textReply('PLAN:\n1. Read the config.'),
        toolUseReply('Read', { file_path: '/etc/config' }, 'c1'),
        // After the tool is denied via hook, the step retries — give the
        // model a chance to give up.
        textReply('cannot proceed'),
      ],
    });

    const session = createFakeSession({ provider });
    session.pluginHost.registerStatic(planExecuteModePlugin);
    session.modes.setActive(PLAN_EXECUTE_MODE_NAME);
    session.tools.register(
      defineTool({
        name: 'Read',
        description: 'read file',
        inputSchema: z.object({ file_path: z.string() }),
        handler: () => 'should-never-run',
      }),
    );

    // A plugin that denies every tool call via onToolCall.
    const onToolCall = vi.fn(async () => ({ action: 'deny' as const, reason: 'blocked by plugin' }));
    session.pluginHost.registerStatic({
      __moxxy: 'plugin' as const,
      name: 'gate',
      version: '0.0.0',
      hooks: { onToolCall },
    });

    const events = await collectTurn(session, 'do x');

    expect(onToolCall).toHaveBeenCalledTimes(1);
    const denied = events.find((e) => e.type === 'tool_call_denied');
    expect(denied).toBeDefined();
    if (denied?.type !== 'tool_call_denied') throw new Error();
    expect(denied.decidedBy).toBe('hook');
    expect(denied.reason).toBe('blocked by plugin');

    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error();
    expect(toolResult.ok).toBe(false);
  });
});
