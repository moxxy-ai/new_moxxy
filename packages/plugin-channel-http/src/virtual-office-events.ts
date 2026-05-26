import {
  type MoxxyEvent,
} from '@moxxy/sdk';

const COMMAND_SESSION_ACTION_SUBTYPE = 'command.session_action';
const COMMAND_STATE_CHANGED_SUBTYPE = 'command.state_changed';
const PERMISSION_REQUESTED_SUBTYPE = 'permission.requested';
const PERMISSION_RESOLVED_SUBTYPE = 'permission.resolved';

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
  if (
    event.subtype === COMMAND_SESSION_ACTION_SUBTYPE &&
    isCommandSessionActionPayload(event.payload)
  ) {
    return {
      ...base,
      event_type: COMMAND_SESSION_ACTION_SUBTYPE,
      payload: { ...event.payload },
    };
  }
  if (
    event.subtype === COMMAND_STATE_CHANGED_SUBTYPE &&
    isCommandStateChangedPayload(event.payload)
  ) {
    return {
      ...base,
      event_type: COMMAND_STATE_CHANGED_SUBTYPE,
      payload: { ...event.payload },
    };
  }
  if (
    (event.subtype === PERMISSION_REQUESTED_SUBTYPE || event.subtype === PERMISSION_RESOLVED_SUBTYPE) &&
    event.payload &&
    typeof event.payload === 'object' &&
    !Array.isArray(event.payload)
  ) {
    const payload = event.payload as Record<string, unknown>;
    return {
      ...base,
      agent_id: typeof payload.agent_id === 'string' ? payload.agent_id : base.agent_id,
      run_id: null,
      event_type: event.subtype,
      payload: { ...payload },
    };
  }
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

function isCommandSessionActionPayload(value: unknown): value is Record<string, unknown> {
  return isCommandPayloadBase(value) && (value as Record<string, unknown>).action === 'new';
}

function isCommandStateChangedPayload(value: unknown): value is Record<string, unknown> {
  if (!isCommandPayloadBase(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.action === 'model_changed') return typeof record.model === 'string';
  if (record.action === 'loop_changed') return typeof record.loop === 'string';
  return false;
}

function isCommandPayloadBase(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.command === 'string' &&
    record.target === 'session' &&
    typeof record.origin_channel === 'string' &&
    typeof record.origin_id === 'string'
  );
}
