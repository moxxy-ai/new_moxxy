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
      return {
        ...base,
        event_type: 'run.started',
        payload: {
          task: event.text,
          ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
        },
      };
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
    case 'tool_call_denied':
      return {
        ...base,
        event_type: 'primitive.failed',
        payload: { call_id: String(event.callId), error: event.reason },
      };
    case 'skill_invoked':
      return { ...base, event_type: 'skill.invoked', payload: { skill_id: event.skillId, name: event.name } };
    case 'provider_request':
      return {
        ...base,
        event_type: 'thinking.started',
        payload: {
          provider: event.provider,
          model: event.model,
          ...(typeof event.inputTokens === 'number' ? { input_tokens: event.inputTokens } : {}),
        },
      };
    case 'provider_response':
      return {
        ...base,
        event_type: 'thinking.completed',
        payload: {
          provider: event.provider,
          model: event.model,
          ...(typeof event.inputTokens === 'number' ? { input_tokens: event.inputTokens } : {}),
          ...(typeof event.outputTokens === 'number' ? { output_tokens: event.outputTokens } : {}),
          ...(typeof event.cacheReadTokens === 'number' ? { cache_read_tokens: event.cacheReadTokens } : {}),
          ...(typeof event.cacheCreationTokens === 'number' ? { cache_creation_tokens: event.cacheCreationTokens } : {}),
        },
      };
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
  const workflowEventType = workflowSubtypeToEventType(event.subtype);
  if (workflowEventType) {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
    return {
      ...base,
      event_type: workflowEventType,
      payload: { ...payload },
    };
  }
  if (typeof event.subtype !== 'string' || !event.subtype.startsWith('subagent_')) return null;
  const payload = event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
  const childSessionId = typeof payload.childSessionId === 'string' && payload.childSessionId.trim()
    ? payload.childSessionId
    : null;
  const childName =
    typeof payload.label === 'string'
      ? payload.label
      : childSessionId
        ? childSessionId
        : 'subagent';
  if (!childSessionId) return null;
  const subagentBase = {
    ...base,
    agent_id: childSessionId,
    parent_run_id: base.run_id,
  };
  const subagentPayload = {
    ...payload,
    parent_agent_id: base.agent_id,
    child_name: childName,
  };
  if (event.subtype === 'subagent_started') {
    return {
      ...subagentBase,
      event_type: 'subagent.spawned',
      payload: subagentPayload,
    };
  }
  if (event.subtype === 'subagent_chunk') {
    const content = typeof payload.delta === 'string' ? payload.delta : '';
    return {
      ...subagentBase,
      event_type: 'message.delta',
      payload: { ...subagentPayload, content, delta: content },
    };
  }
  if (event.subtype === 'subagent_tool_call') {
    return {
      ...subagentBase,
      event_type: 'primitive.invoked',
      payload: {
        ...subagentPayload,
        name: typeof payload.name === 'string' ? payload.name : 'tool',
        input: payload.input,
        call_id: typeof payload.callId === 'string' ? payload.callId : String(payload.callId ?? ''),
      },
    };
  }
  if (event.subtype === 'subagent_tool_result') {
    const ok = payload.ok === true;
    return {
      ...subagentBase,
      event_type: ok ? 'primitive.completed' : 'primitive.failed',
      payload: {
        ...subagentPayload,
        call_id: typeof payload.callId === 'string' ? payload.callId : String(payload.callId ?? ''),
        ...(ok ? { output: payload.output } : { error: normalizeError(payload.error) }),
      },
    };
  }
  if (event.subtype === 'subagent_completed') {
    const failed = payload.stopReason === 'error' || typeof payload.error === 'string';
    return {
      ...subagentBase,
      event_type: failed ? 'subagent.failed' : 'subagent.completed',
      payload: {
        ...subagentPayload,
        ...(typeof payload.text === 'string' ? { result: payload.text } : {}),
        ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
      },
    };
  }
  if (event.subtype === 'subagent_error' || event.subtype === 'subagent_abort') {
    return {
      ...subagentBase,
      event_type: 'subagent.failed',
      payload: {
        ...subagentPayload,
        error: typeof payload.message === 'string'
          ? payload.message
          : typeof payload.reason === 'string'
            ? payload.reason
            : 'subagent failed',
      },
    };
  }
  return null;
}

function workflowSubtypeToEventType(subtype: string): string | null {
  switch (subtype) {
    case 'workflow_started':
      return 'workflow.started';
    case 'workflow_step_started':
      return 'workflow.step.started';
    case 'workflow_step_completed':
      return 'workflow.step.completed';
    case 'workflow_step_skipped':
      return 'workflow.step.skipped';
    case 'workflow_step_failed':
      return 'workflow.step.failed';
    case 'workflow_step_awaiting_input':
      return 'workflow.step.awaiting_input';
    case 'workflow_paused':
      return 'workflow.paused';
    case 'workflow_resumed':
      return 'workflow.resumed';
    case 'workflow_completed':
      return 'workflow.completed';
    case 'workflow_failed':
      return 'workflow.failed';
    default:
      return null;
  }
}

function normalizeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return value == null ? 'unknown error' : String(value);
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
