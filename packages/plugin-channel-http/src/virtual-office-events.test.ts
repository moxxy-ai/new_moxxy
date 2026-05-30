import { describe, expect, it } from 'vitest';
import { asEventId, asPluginId, asSessionId, asTurnId, type MoxxyEvent } from '@moxxy/sdk';
import { eventToVirtualOfficeEnvelope } from './virtual-office-events.js';

describe('eventToVirtualOfficeEnvelope', () => {
  it('maps command session actions for Virtual Office clients', () => {
    const event: MoxxyEvent = {
      id: asEventId('evt-1'),
      seq: 3,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-1'),
      source: 'plugin',
      type: 'plugin_event',
      pluginId: asPluginId('@moxxy/plugin-commands'),
      subtype: 'command.session_action',
      payload: {
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'tui',
        origin_id: 'tui-1',
      },
    };

    expect(eventToVirtualOfficeEnvelope(event)).toEqual({
      agent_id: 'session',
      run_id: 'turn-1',
      parent_run_id: null,
      sequence: 3,
      event_type: 'command.session_action',
      payload: {
        command: '/new',
        action: 'new',
        target: 'session',
        origin_channel: 'tui',
        origin_id: 'tui-1',
      },
      sensitive: false,
    });
  });

  it('maps runtime subagent lifecycle events to the child session id', () => {
    const started: MoxxyEvent = {
      id: asEventId('evt-sub-start'),
      seq: 10,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-parent'),
      source: 'plugin',
      type: 'plugin_event',
      pluginId: asPluginId('@moxxy/subagents'),
      subtype: 'subagent_started',
      payload: {
        label: 'agent-polityka-iran',
        childSessionId: 'child-iran',
        prompt: 'Zbadaj najnowsze informacje o Iranie',
        mode: 'tool-use',
        model: 'gpt-5.5',
      },
    };

    expect(eventToVirtualOfficeEnvelope(started)).toEqual({
      agent_id: 'child-iran',
      run_id: 'turn-parent',
      parent_run_id: 'turn-parent',
      sequence: 10,
      event_type: 'subagent.spawned',
      payload: {
        label: 'agent-polityka-iran',
        childSessionId: 'child-iran',
        prompt: 'Zbadaj najnowsze informacje o Iranie',
        mode: 'tool-use',
        model: 'gpt-5.5',
        parent_agent_id: 'session',
        child_name: 'agent-polityka-iran',
      },
      sensitive: false,
    });
  });

  it('maps runtime subagent progress events to Office-friendly event types', () => {
    const base = {
      id: asEventId('evt-sub'),
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-parent'),
      source: 'plugin' as const,
      type: 'plugin_event' as const,
      pluginId: asPluginId('@moxxy/subagents'),
    };

    const chunk = eventToVirtualOfficeEnvelope({
      ...base,
      id: asEventId('evt-sub-chunk'),
      seq: 11,
      subtype: 'subagent_chunk',
      payload: { label: 'researcher', childSessionId: 'child-a', delta: 'partial answer' },
    });
    const toolCall = eventToVirtualOfficeEnvelope({
      ...base,
      id: asEventId('evt-sub-tool'),
      seq: 12,
      subtype: 'subagent_tool_call',
      payload: { label: 'researcher', childSessionId: 'child-a', name: 'web_fetch', input: { url: 'https://example.com' }, callId: 'call-1' },
    });
    const toolResult = eventToVirtualOfficeEnvelope({
      ...base,
      id: asEventId('evt-sub-tool-result'),
      seq: 13,
      subtype: 'subagent_tool_result',
      payload: { label: 'researcher', childSessionId: 'child-a', callId: 'call-1', ok: true, output: 'ok' },
    });
    const completed = eventToVirtualOfficeEnvelope({
      ...base,
      id: asEventId('evt-sub-complete'),
      seq: 14,
      subtype: 'subagent_completed',
      payload: { label: 'researcher', childSessionId: 'child-a', text: 'final answer', stopReason: 'stop' },
    });
    const aborted = eventToVirtualOfficeEnvelope({
      ...base,
      id: asEventId('evt-sub-abort'),
      seq: 15,
      subtype: 'subagent_abort',
      payload: { label: 'researcher', childSessionId: 'child-a', reason: 'cancelled' },
    });

    expect(chunk).toMatchObject({
      agent_id: 'child-a',
      event_type: 'message.delta',
      payload: { content: 'partial answer', child_name: 'researcher' },
    });
    expect(toolCall).toMatchObject({
      agent_id: 'child-a',
      event_type: 'primitive.invoked',
      payload: { name: 'web_fetch', call_id: 'call-1' },
    });
    expect(toolResult).toMatchObject({
      agent_id: 'child-a',
      event_type: 'primitive.completed',
      payload: { call_id: 'call-1', output: 'ok' },
    });
    expect(completed).toMatchObject({
      agent_id: 'child-a',
      event_type: 'subagent.completed',
      payload: { result: 'final answer', child_name: 'researcher' },
    });
    expect(aborted).toMatchObject({
      agent_id: 'child-a',
      event_type: 'subagent.failed',
      payload: { error: 'cancelled', child_name: 'researcher' },
    });
  });

  it('maps provider request and response to thinking activity events', () => {
    const request: MoxxyEvent = {
      id: asEventId('evt-provider-request'),
      seq: 20,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-1'),
      source: 'model',
      type: 'provider_request',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      inputTokens: 1234,
    };
    const response: MoxxyEvent = {
      id: asEventId('evt-provider-response'),
      seq: 21,
      ts: 124,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-1'),
      source: 'model',
      type: 'provider_response',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      inputTokens: 1234,
      outputTokens: 55,
    };

    expect(eventToVirtualOfficeEnvelope(request)).toMatchObject({
      agent_id: 'session',
      run_id: 'turn-1',
      event_type: 'thinking.started',
      payload: {
        provider: 'openai-codex',
        model: 'gpt-5.5',
        input_tokens: 1234,
      },
    });
    expect(eventToVirtualOfficeEnvelope(response)).toMatchObject({
      agent_id: 'session',
      run_id: 'turn-1',
      event_type: 'thinking.completed',
      payload: {
        provider: 'openai-codex',
        model: 'gpt-5.5',
        input_tokens: 1234,
        output_tokens: 55,
      },
    });
  });

  it('preserves user prompt image attachments for Virtual Office resume previews', () => {
    const event: MoxxyEvent = {
      id: asEventId('evt-user-with-image'),
      seq: 40,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-1'),
      source: 'user',
      type: 'user_prompt',
      text: 'describe this',
      attachments: [
        {
          kind: 'image',
          content: 'aW1hZ2U=',
          mediaType: 'image/png',
          name: 'diagram.png',
        },
      ],
    };

    expect(eventToVirtualOfficeEnvelope(event)).toMatchObject({
      agent_id: 'session',
      run_id: 'turn-1',
      event_type: 'run.started',
      payload: {
        task: 'describe this',
        attachments: [
          {
            kind: 'image',
            content: 'aW1hZ2U=',
            mediaType: 'image/png',
            name: 'diagram.png',
          },
        ],
      },
    });
  });

  it('maps denied tool calls to failed primitive activity', () => {
    const event: MoxxyEvent = {
      id: asEventId('evt-tool-denied'),
      seq: 30,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-1'),
      source: 'tool',
      type: 'tool_call_denied',
      callId: 'call-1',
      decidedBy: 'resolver',
      reason: 'not allowed',
    };

    expect(eventToVirtualOfficeEnvelope(event)).toEqual({
      agent_id: 'session',
      run_id: 'turn-1',
      parent_run_id: null,
      sequence: 30,
      event_type: 'primitive.failed',
      payload: {
        call_id: 'call-1',
        error: 'not allowed',
      },
      sensitive: false,
    });
  });

  it('maps workflow lifecycle plugin events for Office workflow highlighting', () => {
    const base = {
      id: asEventId('evt-workflow'),
      seq: 50,
      ts: 123,
      sessionId: asSessionId('sess-1'),
      turnId: asTurnId('turn-workflow'),
      source: 'plugin' as const,
      type: 'plugin_event' as const,
      pluginId: asPluginId('@moxxy/plugin-workflows'),
    };

    expect(eventToVirtualOfficeEnvelope({
      ...base,
      subtype: 'workflow_started',
      payload: { name: 'daily-digest', steps: 2 },
    })).toMatchObject({
      agent_id: 'session',
      event_type: 'workflow.started',
      payload: { name: 'daily-digest', steps: 2 },
    });
    expect(eventToVirtualOfficeEnvelope({
      ...base,
      seq: 51,
      subtype: 'workflow_step_started',
      payload: { id: 'collect', label: 'Collect' },
    })).toMatchObject({
      event_type: 'workflow.step.started',
      payload: { id: 'collect', label: 'Collect' },
    });
    expect(eventToVirtualOfficeEnvelope({
      ...base,
      seq: 52,
      subtype: 'workflow_step_awaiting_input',
      payload: { id: 'collect', label: 'Collect', childSessionId: 'child-wf', preview: 'What brief?' },
    })).toMatchObject({
      event_type: 'workflow.step.awaiting_input',
      payload: { id: 'collect', childSessionId: 'child-wf' },
    });
    expect(eventToVirtualOfficeEnvelope({
      ...base,
      seq: 53,
      subtype: 'workflow_paused',
      payload: { runId: 'run-01', stepId: 'collect', childSessionId: 'child-wf' },
    })).toMatchObject({
      event_type: 'workflow.paused',
      payload: { runId: 'run-01', childSessionId: 'child-wf' },
    });
    expect(eventToVirtualOfficeEnvelope({
      ...base,
      seq: 54,
      subtype: 'workflow_completed',
      payload: { name: 'daily-digest', output: 'done' },
    })).toMatchObject({
      event_type: 'workflow.completed',
      payload: { name: 'daily-digest', output: 'done' },
    });
  });
});
