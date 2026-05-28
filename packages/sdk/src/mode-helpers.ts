import type { ContentBlock, ProviderEvent, ProviderMessage, TokenUsage } from './provider.js';
import type { ModeContext } from './mode.js';
import type { StopReason } from './provider-utils.js';
import type { Skill } from './skill.js';
import type { CompactionEvent, MoxxyEvent } from './events.js';
import {
  computeElisionState,
  conversationalStub,
  conversationalStubbed,
  toolResultBytes,
  toolResultStub,
  toolResultStubbed,
} from './elision-state.js';
import { applyLazyTools } from './tool-gating.js';
import { runCompactionIfNeeded } from './compactor-helpers.js';
import { runElisionIfNeeded } from './elision-helpers.js';
import { usageEventFields } from './token-accounting.js';

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

/** Appended to the system prompt while elision is active (see projection). */
export const ELISION_SYSTEM_NOTE =
  'Context note: to stay within budget, older turns may appear as stubs like ' +
  '`[output elided — recall("id") to view]` or `[elided user turn · recall({ seq: N })]`. ' +
  'These are NOT the real content — call the `recall` tool with the given id/seq to fetch ' +
  'the full text before relying on any detail from an elided turn. Recent turns are always ' +
  'shown verbatim.';

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
 * This is THE projection every loop strategy uses; it honors compaction
 * events, turn-boundary elision, and the orphan-tool_use fallback. It lives in
 * the SDK so loop plugins stay independent of core.
 */
export interface ProjectedMessages {
  readonly messages: ProviderMessage[];
  /**
   * Index (into `messages`) of the last message belonging to the stable,
   * byte-identical prefix — i.e. produced entirely from events at or below the
   * elision high-water mark (which only advances on whole-turn boundaries, so
   * the cut never splits a message). -1 when no elision is active. The
   * `stable-prefix` cache strategy places its long-lived cross-turn breakpoint
   * here; see {@link collectProviderStream}'s `stablePrefixIndex` option.
   */
  readonly stablePrefixIndex: number;
}

export function projectMessagesFromLog(
  ctx: Pick<ModeContext, 'log'>,
  opts: ProjectMessagesOptions = {},
): ProviderMessage[] {
  return projectMessages(ctx, opts).messages;
}

/**
 * Same projection as {@link projectMessagesFromLog} but also reports the
 * stable-prefix boundary so the active cache strategy can place a cross-turn
 * breakpoint. Modes that build messages this way should thread the returned
 * `stablePrefixIndex` into {@link collectProviderStream}.
 */
export function projectMessages(
  ctx: Pick<ModeContext, 'log'>,
  opts: ProjectMessagesOptions = {},
): ProjectedMessages {
  const allEvents = ctx.log.slice();
  const compactions = activeCompactionRanges(allEvents);
  const emittedCompactions = new Set<CompactionRange>();
  const el = computeElisionState(allEvents);

  const messages: ProviderMessage[] = [];
  // The stable prefix is every message produced from events at/below the
  // elision HWM. Record the latest such message index as we push.
  let stablePrefixIndex = -1;
  const recordStable = (maxSeq: number): void => {
    if (el.hwm >= 0 && maxSeq >= 0 && maxSeq <= el.hwm) {
      stablePrefixIndex = messages.length - 1;
    }
  };
  if (opts.systemPrompt) {
    // When elision is active, tell the model that older turns may be shown as
    // stubs and how to expand them — so it recalls instead of hallucinating.
    // Constant text → busts the system cache once (when elision starts), stable
    // thereafter.
    const sysText = el.hwm >= 0 ? `${opts.systemPrompt}\n\n${ELISION_SYSTEM_NOTE}` : opts.systemPrompt;
    messages.push({ role: 'system', content: [{ type: 'text', text: sysText }] });
  }
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
  let pendingAssistantMaxSeq = -1;
  const flush = (): void => {
    if (!pendingAssistant) return;
    const flushed = pendingAssistant;
    const groupMaxSeq = pendingAssistantMaxSeq;
    pendingAssistant = null;
    pendingAssistantMaxSeq = -1;
    messages.push(flushed);
    recordStable(groupMaxSeq);
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
        recordStable(groupMaxSeq);
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
        recordStable(compaction.to);
      }
      continue;
    }

    switch (e.type) {
      case 'user_prompt': {
        flush();
        // Elided + conversational: collapse to a stub (anchor/tiny kept full).
        if (conversationalStubbed(e, el)) {
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: conversationalStub('user', e.seq) }],
          });
          recordStable(e.seq);
          break;
        }
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
        recordStable(e.seq);
        break;
      }
      case 'assistant_message':
        flush();
        if (conversationalStubbed(e, el)) {
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: conversationalStub('assistant', e.seq) }],
          });
          recordStable(e.seq);
          break;
        }
        messages.push({ role: 'assistant', content: [{ type: 'text', text: e.content }] });
        recordStable(e.seq);
        break;
      case 'tool_call_requested': {
        pendingAssistant ??= { role: 'assistant', content: [] };
        pendingAssistantMaxSeq = Math.max(pendingAssistantMaxSeq, e.seq);
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
        // Stub bulky old tool output to a recall-able marker (decision shared
        // with estimateContextTokens via toolResultStubbed).
        let text: string;
        if (toolResultStubbed(e, el)) {
          const recalled = el.recalledCallIds.has(e.callId) || el.recalledSeqs.has(e.seq);
          text = toolResultStub(e.callId, toolResultBytes(e.output), recalled);
        } else if (e.error) {
          text = `[error:${e.error.kind}] ${e.error.message}`;
        } else {
          text = typeof e.output === 'string' ? e.output : JSON.stringify(e.output ?? '');
        }
        messages.push({
          role: 'tool_result',
          content: [{ type: 'tool_result', toolUseId: e.callId, content: text, isError: !e.ok }],
        });
        recordStable(e.seq);
        break;
      }
      default:
        break;
    }
  }
  flush();

  if (opts.trailingUserText) {
    // The trailing step nudge is volatile (changes per step), never part of
    // the stable prefix — don't record it.
    messages.push({ role: 'user', content: [{ type: 'text', text: opts.trailingUserText }] });
  }
  return { messages, stablePrefixIndex };
}

export interface StreamResult {
  readonly text: string;
  readonly toolUses: ReadonlyArray<CollectedToolUse>;
  readonly stopReason: StopReason;
  readonly error: { readonly message: string; readonly retryable: boolean } | null;
  /** Token usage reported by the provider on `message_end`, including cache hits/writes. */
  readonly usage?: TokenUsage;
}

/**
 * Pulls a provider stream, emits `assistant_chunk` events for text deltas,
 * collects tool_use blocks, and returns the final `{text, toolUses, stopReason}`.
 * Runs `onBeforeProviderCall` lifecycle hooks before the call.
 */
export async function collectProviderStream(
  ctx: ModeContext,
  messages: ReadonlyArray<ProviderMessage>,
  opts: {
    iteration?: number;
    includeTools?: boolean;
    maxTokens?: number;
    /**
     * Index (into `messages`) of the last stable-prefix message, from
     * {@link projectMessages}. Passed to the active cache strategy as
     * `stablePrefixMessageIndex` so it can place a long-lived cross-turn
     * breakpoint at the elision boundary. Omit (or -1) when unknown — the
     * strategy then falls back to its tools/system/tail breakpoints only.
     */
    stablePrefixIndex?: number;
  } = {},
): Promise<StreamResult> {
  // Lazy tool gating (opt-in): send only always-on + loaded tool schemas, and
  // index the rest in the system prompt. Runs BEFORE cache planning since it
  // rewrites the system message and the tool list.
  let effectiveMessages = messages;
  let toolList: ReadonlyArray<import('./tool.js').ToolDef> | undefined =
    opts.includeTools === false ? undefined : ctx.tools.list();
  if (ctx.lazyTools && toolList) {
    const gated = applyLazyTools(messages, toolList, ctx.log);
    effectiveMessages = gated.messages;
    toolList = gated.tools;
  }

  // Ask the active cache strategy where to place prompt-cache breakpoints.
  // The strategy is provider-neutral (returns CacheHints); the provider
  // translates them (Anthropic → cache_control). Falls back to no hints when
  // no strategy is registered. The onBeforeProviderCall hook can still adjust.
  const descriptor = ctx.provider.models.find((m) => m.id === ctx.model);
  const cacheHints = ctx.cacheStrategy
    ? ctx.cacheStrategy.plan(effectiveMessages, {
        model: ctx.model,
        contextWindow: descriptor?.contextWindow ?? 0,
        log: ctx.log,
        ...(opts.stablePrefixIndex != null && opts.stablePrefixIndex >= 0
          ? { stablePrefixMessageIndex: opts.stablePrefixIndex }
          : {}),
      })
    : undefined;

  const req = {
    model: ctx.model,
    system: ctx.systemPrompt,
    messages: effectiveMessages,
    ...(toolList ? { tools: toolList } : {}),
    ...(cacheHints && cacheHints.length > 0 ? { cacheHints } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
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
  let usage: TokenUsage | undefined;

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
          if (event.usage) usage = event.usage;
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
  return { text, toolUses: finalToolUses, stopReason, error, ...(usage ? { usage } : {}) };
}

/**
 * Run a single-shot (no-tools) provider turn — the shape every planner /
 * synthesis phase shares. Runs context management (compaction + elision),
 * emits the `provider_request` bookend, streams the response with tools
 * disabled, then emits either an `error` event (returning `null`) or the
 * `provider_response` bookend (returning the collected text).
 *
 * Replaces the ~40-line block each mode phase used to inline; centralizing it
 * keeps event emission uniform and means a fix here (e.g. always running
 * elision) lands for every loop strategy at once.
 */
export async function runSingleShotTurn(
  ctx: ModeContext,
  messages: ReadonlyArray<ProviderMessage>,
  opts: { maxTokens?: number } = {},
): Promise<string | null> {
  await runCompactionIfNeeded(ctx);
  await runElisionIfNeeded(ctx);

  await ctx.emit({
    type: 'provider_request',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
  });

  const { text, usage, error } = await collectProviderStream(ctx, messages, {
    includeTools: false,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  });
  if (error) {
    await ctx.emit({
      type: 'error',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      source: 'system',
      kind: error.retryable ? 'retryable' : 'fatal',
      message: error.message,
    });
    return null;
  }

  await ctx.emit({
    type: 'provider_response',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    source: 'system',
    provider: ctx.provider.name,
    model: ctx.model,
    ...usageEventFields(usage),
  });

  return text;
}

/**
 * Sliding-window detector for "model keeps making the same tool call".
 *
 * When the same `(toolName, input)` pair appears `repeatThreshold` times in
 * the last `windowSize` calls, the model is almost certainly stuck — polling a
 * tool that returns the same thing, mis-handling an error, etc. Bail early
 * instead of burning through the iteration cap.
 *
 * Shared across every loop strategy so detection is uniform — previously each
 * mode re-rolled this, and one copy used a non-canonical `JSON.stringify`
 * signature that silently missed key-reordered repeats.
 */
export interface StuckLoopDetector {
  readonly windowSize: number;
  readonly repeatThreshold: number;
  /** Record the call. Returns the number of identical calls in the window. */
  record(toolName: string, input: unknown): number;
}

export function createStuckLoopDetector(
  opts: { windowSize?: number; repeatThreshold?: number } = {},
): StuckLoopDetector {
  const windowSize = opts.windowSize ?? 8;
  const repeatThreshold = opts.repeatThreshold ?? 3;
  const recent: string[] = [];
  return {
    windowSize,
    repeatThreshold,
    record(toolName, input) {
      const key = `${toolName}|${stableHash(input)}`;
      recent.push(key);
      if (recent.length > windowSize) recent.shift();
      return recent.filter((k) => k === key).length;
    },
  };
}

/**
 * Stable, key-order-canonical hash of a tool call's input, so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same key. Use for any "have I seen this call before"
 * comparison — a raw `JSON.stringify` is NOT order-stable.
 */
export function stableHash(input: unknown): string {
  return canonicalize(input);
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v)).join(',') + '}';
}
