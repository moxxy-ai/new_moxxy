import type { ProviderEvent, StopReason } from '@moxxy/sdk';
import type { PendingFunctionCall, ResponsesSseEvent, SseStepResult } from './stream-types.js';

/**
 * Map a single Responses-API SSE event to zero or more moxxy ProviderEvents.
 * Centralized here so the streaming loop stays a thin "read frame → call
 * this → yield" structure and the event taxonomy is easy to test directly.
 *
 * Events we care about (subset of the full Responses API surface):
 *   response.output_text.delta         → text_delta
 *   response.output_item.added         → tool_use_start (if it's a function_call)
 *   response.function_call_arguments.delta → tool_use_delta
 *   response.function_call_arguments.done  → finalize tool_use_end
 *   response.completed                 → message_end (sets stopReason)
 *   response.failed / response.error   → error
 */
export function handleSseEvent(
  ev: ResponsesSseEvent,
  pending: Map<string, PendingFunctionCall>,
): SseStepResult {
  const type = ev.type ?? '';

  if (type === 'response.output_text.delta' && typeof ev.delta === 'string' && ev.delta) {
    return { events: [{ type: 'text_delta', delta: ev.delta }] };
  }

  if (type === 'response.output_item.added' && ev.item?.type === 'function_call') {
    const id = ev.item.id ?? ev.item.call_id ?? `call_${pending.size}`;
    const callId = ev.item.call_id ?? id;
    const name = ev.item.name ?? '';
    const entry: PendingFunctionCall = {
      id,
      callId,
      name,
      args: ev.item.arguments ?? '',
      emittedStart: false,
    };
    pending.set(id, entry);
    if (name) {
      entry.emittedStart = true;
      return { events: [{ type: 'tool_use_start', id: callId, name }] };
    }
    return {};
  }

  if (type === 'response.function_call_arguments.delta') {
    const id = ev.item_id ?? ev.call_id ?? '';
    const entry = pending.get(id);
    const delta = ev.delta ?? '';
    if (entry && typeof delta === 'string') {
      entry.args += delta;
      const outId = entry.callId || entry.id;
      // If we hadn't emitted tool_use_start yet (server sent the args
      // before the item.added with a name), do so now using whatever
      // name landed later. Defensive — opencode's pattern.
      const startEvents: ProviderEvent[] = [];
      if (!entry.emittedStart && entry.name) {
        entry.emittedStart = true;
        startEvents.push({ type: 'tool_use_start', id: outId, name: entry.name });
      }
      return {
        events: [...startEvents, { type: 'tool_use_delta', id: outId, partialInput: delta }],
      };
    }
    return {};
  }

  if (type === 'response.function_call_arguments.done') {
    const id = ev.item_id ?? ev.call_id ?? '';
    const entry = pending.get(id);
    if (!entry) return {};
    pending.delete(id);
    if (typeof ev.arguments === 'string' && ev.arguments) entry.args = ev.arguments;
    let input: unknown = {};
    if (entry.args) {
      try {
        input = JSON.parse(entry.args);
      } catch {
        input = { _rawPartial: entry.args };
      }
    }
    const outId = entry.callId || entry.id;
    const events: ProviderEvent[] = [];
    if (!entry.emittedStart && entry.name) {
      events.push({ type: 'tool_use_start', id: outId, name: entry.name });
    }
    events.push({ type: 'tool_use_end', id: outId, input });
    return { events };
  }

  if (type === 'response.completed') {
    const usage = ev.response?.usage;
    const incomplete = ev.response?.incomplete_details?.reason;
    let stopReason: StopReason = 'end_turn';
    if (incomplete === 'max_output_tokens') stopReason = 'max_tokens';
    else if (incomplete === 'stop_sequence') stopReason = 'stop_sequence';
    // The presence of unflushed function calls would already get mapped to
    // tool_use by the post-loop logic; the explicit "completed" event
    // doesn't carry a tool_use stop reason on its own.
    return {
      stopReason,
      ...(usage
        ? { usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } }
        : {}),
      terminal: true,
    };
  }

  if (type === 'response.failed' || type === 'response.error' || type === 'error') {
    const msg = ev.error?.message ?? `Codex stream failed: ${type}`;
    return { events: [{ type: 'error', message: msg, retryable: false }], terminal: true };
  }

  return {};
}
