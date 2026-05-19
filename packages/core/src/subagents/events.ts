/**
 * Subagent <-> parent log bridge. Wraps child `MoxxyEvent`s into
 * `plugin_event` envelopes on the parent log so the TUI / exporters can
 * render live progress, and emits the start/completed bookend envelopes.
 */

import type {
  MoxxyEvent,
  SessionId,
  StopReason,
  SubagentSpec,
  TurnId,
} from '@moxxy/sdk';
import { asPluginId } from '@moxxy/sdk';
import type { Session } from '../session.js';

export const SUBAGENT_PLUGIN_ID = asPluginId('@moxxy/subagents');

export async function emitSubagentStart(
  parentSession: Session,
  parentTurnId: TurnId,
  label: string,
  childSessionId: SessionId,
  spec: SubagentSpec,
  loopStrategy: string,
): Promise<void> {
  await parentSession.log.append({
    type: 'plugin_event',
    sessionId: parentSession.id,
    turnId: parentTurnId,
    source: 'plugin',
    pluginId: SUBAGENT_PLUGIN_ID,
    subtype: 'subagent_started',
    payload: {
      label,
      childSessionId: String(childSessionId),
      prompt: spec.prompt,
      loopStrategy,
      ...(spec.model ? { model: spec.model } : {}),
    },
  });
}

export async function emitSubagentCompleted(
  parentSession: Session,
  parentTurnId: TurnId,
  label: string,
  childSessionId: SessionId,
  text: string,
  stopReason: StopReason,
  errorMessage: string | null,
): Promise<void> {
  await parentSession.log.append({
    type: 'plugin_event',
    sessionId: parentSession.id,
    turnId: parentTurnId,
    source: 'plugin',
    pluginId: SUBAGENT_PLUGIN_ID,
    subtype: 'subagent_completed',
    payload: {
      label,
      childSessionId: String(childSessionId),
      text,
      stopReason,
      ...(errorMessage ? { error: errorMessage } : {}),
    },
  });
}

export async function emitSubagentWarning(
  parentSession: Session,
  parentTurnId: TurnId,
  label: string,
  childSessionId: SessionId,
  message: string,
): Promise<void> {
  await parentSession.log.append({
    type: 'plugin_event',
    sessionId: parentSession.id,
    turnId: parentTurnId,
    source: 'plugin',
    pluginId: SUBAGENT_PLUGIN_ID,
    subtype: 'subagent_warning',
    payload: {
      label,
      childSessionId: String(childSessionId),
      message,
    },
  });
}

/**
 * Map each interesting child event to a parent `plugin_event` so the TUI
 * can render the subagent's progress in real time. Noisy / book-keeping
 * events (loop_iteration, provider_request, provider_response,
 * assistant_message — covered by the explicit `subagent_completed`) are
 * filtered out to keep the parent log lean.
 */
export async function streamChildEventToParent(
  parentSession: Session,
  parentTurnId: TurnId,
  label: string,
  childSessionId: SessionId,
  childEvt: MoxxyEvent,
): Promise<void> {
  const mapped = mapChildEvent(label, childSessionId, childEvt);
  if (!mapped) return;
  await parentSession.log.append({
    type: 'plugin_event',
    sessionId: parentSession.id,
    turnId: parentTurnId,
    source: 'plugin',
    pluginId: SUBAGENT_PLUGIN_ID,
    subtype: mapped.subtype,
    payload: mapped.payload,
  });
}

function mapChildEvent(
  label: string,
  childSessionId: SessionId,
  childEvt: MoxxyEvent,
): { subtype: string; payload: Record<string, unknown> } | null {
  const payload: Record<string, unknown> = {
    label,
    childSessionId: String(childSessionId),
  };
  switch (childEvt.type) {
    case 'assistant_chunk':
      payload.delta = childEvt.delta;
      return { subtype: 'subagent_chunk', payload };
    case 'tool_call_requested':
      payload.name = childEvt.name;
      payload.input = childEvt.input;
      payload.callId = String(childEvt.callId);
      return { subtype: 'subagent_tool_call', payload };
    case 'tool_result':
      payload.callId = String(childEvt.callId);
      payload.ok = childEvt.ok;
      if (childEvt.ok) payload.output = childEvt.output;
      else payload.error = childEvt.error;
      return { subtype: 'subagent_tool_result', payload };
    case 'error':
      payload.kind = childEvt.kind;
      payload.message = childEvt.message;
      return { subtype: 'subagent_error', payload };
    case 'abort':
      payload.reason = childEvt.reason;
      return { subtype: 'subagent_abort', payload };
    case 'plugin_event':
      return mapNestedPluginEvent(label, payload, childEvt);
    default:
      return null;
  }
}

function mapNestedPluginEvent(
  label: string,
  payload: Record<string, unknown>,
  childEvt: Extract<MoxxyEvent, { type: 'plugin_event' }>,
): { subtype: string; payload: Record<string, unknown> } | null {
  // Bubble nested subagent events too, so a grand-child's progress
  // surfaces all the way up. We strip the nested label-prefix to
  // keep things compact; payload retains the chain via the embedded
  // childSessionId.
  const nestedSubtype = childEvt.subtype;
  if (typeof nestedSubtype !== 'string' || !nestedSubtype.startsWith('subagent_')) return null;
  const nestedPayload = childEvt.payload;
  if (nestedPayload && typeof nestedPayload === 'object') {
    for (const [k, v] of Object.entries(nestedPayload as Record<string, unknown>)) {
      if (k !== 'label' && k !== 'childSessionId') payload[k] = v;
    }
    // Preserve the chain via a `via` field naming the immediate parent label.
    payload.via = label;
  }
  return { subtype: nestedSubtype, payload };
}
