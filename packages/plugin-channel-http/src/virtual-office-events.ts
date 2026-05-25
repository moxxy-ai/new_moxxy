import type { MoxxyEvent } from '@moxxy/sdk';

export interface VirtualOfficeEnvelope {
  agent_id: string;
  run_id: string | null;
  parent_run_id: string | null;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  sensitive: boolean;
}

export function eventToVirtualOfficeEnvelope(
  event: MoxxyEvent,
  agentId = 'session',
): VirtualOfficeEnvelope | null {
  const base = {
    agent_id: agentId,
    run_id: String(event.turnId),
    parent_run_id: null,
    sequence: event.seq,
    sensitive: false,
  };
  switch (event.type) {
    case 'user_prompt':
      return { ...base, event_type: 'run.started', payload: { task: event.text } };
    case 'assistant_chunk':
      return { ...base, event_type: 'message.delta', payload: { content: event.delta } };
    case 'assistant_message':
      return { ...base, event_type: 'message.final', payload: { content: event.content } };
    case 'tool_call_requested':
      return {
        ...base,
        event_type: 'primitive.invoked',
        payload: { name: event.name, input: event.input, call_id: String(event.callId) },
      };
    case 'tool_result':
      return {
        ...base,
        event_type: event.ok ? 'primitive.completed' : 'primitive.failed',
        payload: {
          call_id: String(event.callId),
          ...(event.ok ? { output: event.output } : { error: event.error?.message }),
        },
      };
    case 'skill_invoked':
      return { ...base, event_type: 'skill.invoked', payload: { skill_id: event.skillId, name: event.name } };
    case 'plugin_event':
      return pluginEventToVirtualOfficeEnvelope(event, base);
    case 'abort':
      return { ...base, event_type: 'run.failed', payload: { error: event.reason } };
    case 'error':
      return { ...base, event_type: 'run.failed', payload: { error: event.message } };
    default:
      return null;
  }
}

function pluginEventToVirtualOfficeEnvelope(
  event: Extract<MoxxyEvent, { type: 'plugin_event' }>,
  base: Omit<VirtualOfficeEnvelope, 'event_type' | 'payload'>,
): VirtualOfficeEnvelope | null {
  if (typeof event.subtype !== 'string' || !event.subtype.startsWith('subagent_')) return null;
  const payload = event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
  const childName =
    typeof payload.label === 'string'
      ? payload.label
      : typeof payload.childSessionId === 'string'
        ? payload.childSessionId
        : 'subagent';
  if (event.subtype === 'subagent_started') {
    return {
      ...base,
      event_type: 'subagent.spawned',
      payload: { ...payload, child_name: childName },
    };
  }
  if (event.subtype === 'subagent_completed') {
    const failed = payload.stopReason === 'error' || typeof payload.error === 'string';
    return {
      ...base,
      event_type: failed ? 'subagent.failed' : 'subagent.completed',
      payload: { ...payload, child_name: childName },
    };
  }
  return null;
}
