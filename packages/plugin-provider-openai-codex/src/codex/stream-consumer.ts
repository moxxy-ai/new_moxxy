import { isRetryableError, type ProviderEvent, type StopReason } from '@moxxy/sdk';
import { handleSseEvent } from './sse-event-handler.js';
import type { PendingFunctionCall, ResponsesSseEvent } from './stream-types.js';

export function toErrorEvent(err: unknown): ProviderEvent {
  return {
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
    retryable: isRetryableError(err),
  };
}

export async function* consumeResponsesSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<ProviderEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const pending = new Map<string, PendingFunctionCall>();
  let stopReason: StopReason = 'end_turn';
  let usageIn = 0;
  let usageOut = 0;
  // Tracks whether ANY tool_use_end was yielded during the stream.
  // The Responses API's `response.completed` event doesn't differentiate
  // text-only vs tool-use turns, so without this we'd report end_turn
  // even when tools were requested — the upstream tool-use loop would
  // then drop the calls without executing them.
  let sawToolCall = false;

  try {
    while (true) {
      if (signal?.aborted) {
        yield { type: 'error', message: 'aborted', retryable: false };
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines (\n\n). Some servers emit
      // \r\n\r\n; normalize first.
      buffer = buffer.replace(/\r\n/g, '\n');

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trimStart();
          if (!payload || payload === '[DONE]') continue;

          let json: ResponsesSseEvent;
          try {
            json = JSON.parse(payload) as ResponsesSseEvent;
          } catch {
            continue;
          }
          const result = handleSseEvent(json, pending);
          if (result.events) {
            for (const ev of result.events) {
              if (ev.type === 'tool_use_end') sawToolCall = true;
              yield ev;
            }
          }
          if (result.stopReason) stopReason = result.stopReason;
          if (result.usage) {
            usageIn = result.usage.input ?? usageIn;
            usageOut = result.usage.output ?? usageOut;
          }
        }
      }
    }
  } catch (err) {
    yield toErrorEvent(err);
    return;
  }

  // Flush any tool_call_end events that didn't have a matching .done frame
  // (defensive — the server normally sends function_call.done, but a
  // truncated stream shouldn't drop the entire tool-use sequence).
  for (const entry of pending.values()) {
    if (entry.emittedStart) {
      let input: unknown = {};
      if (entry.args) {
        try {
          input = JSON.parse(entry.args);
        } catch {
          input = { _rawPartial: entry.args };
        }
      }
      sawToolCall = true;
      yield { type: 'tool_use_end', id: entry.callId || entry.id, input };
    }
  }

  // If we yielded any tool_use_end this stream, the turn IS a tool-use
  // turn regardless of what `response.completed` said. The Responses API
  // sends `completed` with no stop_reason field, so we infer from the
  // events we actually emitted. Without this upgrade, codex turns with
  // tool calls were reported as end_turn and the loop dropped them.
  if (stopReason === 'end_turn' && sawToolCall) {
    stopReason = 'tool_use';
  }

  yield {
    type: 'message_end',
    stopReason,
    ...(usageIn > 0 || usageOut > 0
      ? { usage: { inputTokens: usageIn, outputTokens: usageOut } }
      : {}),
  };
}
