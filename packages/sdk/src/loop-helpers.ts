import type { ContentBlock, ProviderEvent, ProviderMessage } from './provider.js';
import type { LoopContext } from './loop.js';
import type { StopReason } from './provider-utils.js';
import type { Skill } from './skill.js';
import type { CompactionEvent, MoxxyEvent } from './events.js';

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

/**
 * Compose a model-facing system prompt that includes any base prompt
 * plus a COMPACT skill index (name + description + triggers only).
 *
 * Lazy-loading design: the body is intentionally NOT inlined. The model
 * matches user intent against the description/triggers, then calls the
 * `load_skill` tool to fetch the body of the skill it picked. This keeps
 * the system prompt small even with many skills installed and avoids
 * paying for skill bodies the model never actually follows.
 */
export function buildSystemPromptWithSkills(
  baseSystemPrompt: string | undefined,
  skills: ReadonlyArray<Skill>,
): string | undefined {
  if (skills.length === 0) return baseSystemPrompt;
  const header =
    `## Available skills\n\n` +
    `Each line below is a pre-authored playbook for a specific intent. ` +
    `When the user's request matches one of these (by name, description, ` +
    `or triggers), call \`load_skill({ name: "<skill-name>" })\` FIRST to ` +
    `fetch the full instructions, then follow them verbatim. Prefer using ` +
    `a skill over re-deriving the workflow with ad-hoc tools.\n`;
  const entries = skills
    .map((s) => {
      const fm = s.frontmatter;
      const triggerHint = fm.triggers?.length
        ? ` (triggers: ${fm.triggers.map((t) => `"${t}"`).join(', ')})`
        : '';
      return `- **${fm.name}** — ${fm.description}${triggerHint}`;
    })
    .join('\n');
  const skillBlock = `${header}\n${entries}`;
  return baseSystemPrompt ? `${baseSystemPrompt}\n\n${skillBlock}` : skillBlock;
}

export interface ProjectMessagesOptions {
  /** Optional system prompt; emitted as the first message when set. */
  readonly systemPrompt?: string;
  /** Optional trailing user message — useful for plan-execute's "Focus on this step now: X". */
  readonly trailingUserText?: string;
}

interface CompactionRange {
  readonly from: number;
  readonly to: number;
  readonly summary: string;
}

function activeCompactionRanges(events: ReadonlyArray<MoxxyEvent>): ReadonlyArray<CompactionRange> {
  return events
    .filter((event): event is CompactionEvent =>
      event.type === 'compaction' &&
      event.tokensSaved > 0 &&
      event.summary.trim().length > 0 &&
      event.replacedRange[0] <= event.replacedRange[1],
    )
    .map((event) => ({
      from: event.replacedRange[0],
      to: event.replacedRange[1],
      summary: event.summary,
    }));
}

function eventInCompactionRange(
  seq: number,
  ranges: ReadonlyArray<CompactionRange>,
): CompactionRange | null {
  for (const range of ranges) {
    if (seq >= range.from && seq <= range.to) return range;
  }
  return null;
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

  const allEvents = ctx.log.slice();
  const compactions = activeCompactionRanges(allEvents);
  const emittedCompactions = new Set<CompactionRange>();
  // Pre-scan: build the set of callIds that have a matching tool_result
  // (or tool_call_denied) somewhere in the log. Used to synthesize a
  // fallback `[interrupted]` tool_result for orphan tool_use blocks
  // when the assistant message gets flushed.
  //
  // Without this fallback the provider rejects the whole conversation
  // with "assistant message with 'tool_calls' must be followed by tool
  // messages responding to each 'tool_call_id'". Orphans typically
  // appear after a cancelled turn, an aborted process, or a tool
  // exception that bypassed the loop's tool_result emit path.
  const resolvedCallIds = new Set<string>();
  for (const e of allEvents) {
    if (e.type === 'tool_result' || e.type === 'tool_call_denied') {
      resolvedCallIds.add(e.callId);
    }
  }

  let pendingAssistant: ProviderMessage | null = null;
  const flush = (): void => {
    if (!pendingAssistant) return;
    const flushed = pendingAssistant;
    messages.push(flushed);
    pendingAssistant = null;
    // Synthesize fallback tool_result messages for any tool_use blocks
    // whose callId never resolved in the event log. Has to land
    // immediately after the assistant message (and before any
    // subsequent user_prompt / assistant_message) so the provider sees
    // a clean assistant→tool-result chain.
    for (const block of flushed.content) {
      if (block.type === 'tool_use' && !resolvedCallIds.has(block.id)) {
        messages.push({
          role: 'tool_result',
          content: [
            {
              type: 'tool_result',
              toolUseId: block.id,
              content: '[tool call did not return a result — possibly interrupted or cancelled]',
              isError: true,
            },
          ],
        });
        // Mark synthesized so we don't double-emit if the same orphan
        // appears in multiple groups (defensive — shouldn't normally
        // happen since each tool_call_requested has a unique callId).
        resolvedCallIds.add(block.id);
      }
    }
  };

  for (const e of allEvents) {
    const compaction = eventInCompactionRange(e.seq, compactions);
    if (compaction) {
      if (!emittedCompactions.has(compaction)) {
        emittedCompactions.add(compaction);
        flush();
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: `[summary of earlier turns]\n${compaction.summary}` }],
        });
      }
      continue;
    }

    switch (e.type) {
      case 'user_prompt': {
        flush();
        const blocks: ContentBlock[] = [{ type: 'text', text: e.text }];
        if (e.attachments) {
          for (const att of e.attachments) {
            if (att.kind === 'image') {
              blocks.push({
                type: 'image',
                mediaType: att.mediaType ?? 'image/png',
                data: att.content,
              });
            } else {
              blocks.push({
                type: 'text',
                text: `[${att.kind}${att.name ? ` ${att.name}` : ''}]\n${att.content}`,
              });
            }
          }
        }
        messages.push({ role: 'user', content: blocks });
        break;
      }
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
