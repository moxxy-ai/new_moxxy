import type { ProviderEvent, ProviderMessage } from './provider.js';
import type { LoopContext } from './loop.js';
import type { StopReason } from './provider-utils.js';

/**
 * Shared bits used by every loop strategy: a typed tool-use struct and a
 * common stream-collection helper that runs `onBeforeProviderCall` hooks
 * and reduces a provider stream down to `{text, toolUses, stopReason}`.
 *
 * Lives in core (not in each loop package) so a new loop strategy stays
 * consistent — and so behavioral fixes here propagate. Previously
 * loop-plan-execute had its own copy that skipped the hook (audit bug).
 */

export interface CollectedToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ProjectMessagesOptions {
  /** Optional system prompt; emitted as the first message when set. */
  readonly systemPrompt?: string;
  /** Optional trailing user message — useful for plan-execute's "Focus on this step now: X". */
  readonly trailingUserText?: string;
}

/**
 * Project the session's event log to a flat list of ProviderMessages
 * suitable for handing to `provider.stream`. Used by every loop strategy.
 *
 * Handles user_prompt, assistant_message, tool_call_requested (grouped
 * into a single assistant message of tool_use blocks), and tool_result.
 * Other event types are passed through as a no-op.
 *
 * Note: this is the minimal projection used by loop strategies. Core's
 * `selectMessages` is a richer variant that also honors compaction events
 * and attachments; the simpler form here lives in the SDK so loop plugins
 * stay independent of core.
 */
export function projectMessagesFromLog(
  ctx: Pick<LoopContext, 'log'>,
  opts: ProjectMessagesOptions = {},
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: [{ type: 'text', text: opts.systemPrompt }] });
  }

  let pendingAssistant: ProviderMessage | null = null;
  const flush = (): void => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };

  for (const e of ctx.log.slice()) {
    switch (e.type) {
      case 'user_prompt':
        flush();
        messages.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
        break;
      case 'assistant_message':
        flush();
        messages.push({ role: 'assistant', content: [{ type: 'text', text: e.content }] });
        break;
      case 'tool_call_requested': {
        pendingAssistant ??= { role: 'assistant', content: [] };
        (pendingAssistant.content as Array<ProviderMessage['content'][number]>).push({
          type: 'tool_use',
          id: e.callId,
          name: e.name,
          input: e.input,
        });
        break;
      }
      case 'tool_result': {
        flush();
        const text = e.error
          ? `[error:${e.error.kind}] ${e.error.message}`
          : typeof e.output === 'string'
            ? e.output
            : JSON.stringify(e.output ?? '');
        messages.push({
          role: 'tool_result',
          content: [{ type: 'tool_result', toolUseId: e.callId, content: text, isError: !e.ok }],
        });
        break;
      }
      default:
        break;
    }
  }
  flush();

  if (opts.trailingUserText) {
    messages.push({ role: 'user', content: [{ type: 'text', text: opts.trailingUserText }] });
  }
  return messages;
}

export interface StreamResult {
  readonly text: string;
  readonly toolUses: ReadonlyArray<CollectedToolUse>;
  readonly stopReason: StopReason;
  readonly error: { readonly message: string; readonly retryable: boolean } | null;
}

/**
 * Pulls a provider stream, emits `assistant_chunk` events for text deltas,
 * collects tool_use blocks, and returns the final `{text, toolUses, stopReason}`.
 * Runs `onBeforeProviderCall` lifecycle hooks before the call.
 */
export async function collectProviderStream(
  ctx: LoopContext,
  messages: ReadonlyArray<ProviderMessage>,
  opts: { iteration?: number; includeTools?: boolean } = {},
): Promise<StreamResult> {
  const req = {
    model: ctx.model,
    system: ctx.systemPrompt,
    messages,
    ...(opts.includeTools === false ? {} : { tools: ctx.tools.list() }),
    signal: ctx.signal,
  };
  const transformed = await ctx.hooks.dispatchBeforeProviderCall(req, {
    sessionId: ctx.sessionId,
    cwd: '',
    log: ctx.log,
    env: {},
    turnId: ctx.turnId,
    iteration: opts.iteration ?? 0,
  });

  let text = '';
  const toolUses = new Map<string, { name?: string; input?: unknown }>();
  let stopReason: StopReason = 'end_turn';
  let error: StreamResult['error'] = null;

  let stream: AsyncIterable<ProviderEvent>;
  try {
    stream = ctx.provider.stream(transformed);
  } catch (err) {
    return {
      text: '',
      toolUses: [],
      stopReason: 'error',
      error: { message: err instanceof Error ? err.message : String(err), retryable: false },
    };
  }

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta': {
          text += event.delta;
          await ctx.emit({
            type: 'assistant_chunk',
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            source: 'model',
            delta: event.delta,
          });
          break;
        }
        case 'tool_use_start': {
          toolUses.set(event.id, { name: event.name });
          break;
        }
        case 'tool_use_end': {
          const existing = toolUses.get(event.id) ?? {};
          toolUses.set(event.id, { ...existing, input: event.input });
          break;
        }
        case 'message_end': {
          stopReason = event.stopReason;
          break;
        }
        case 'error': {
          error = { message: event.message, retryable: event.retryable };
          break;
        }
        case 'message_start':
        case 'tool_use_delta':
        default:
          break;
      }
    }
  } catch (err) {
    error = {
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }

  const finalToolUses: CollectedToolUse[] = [];
  for (const [id, partial] of toolUses) {
    if (!partial.name) continue;
    finalToolUses.push({ id, name: partial.name, input: partial.input ?? {} });
  }
  return { text, toolUses: finalToolUses, stopReason, error };
}
