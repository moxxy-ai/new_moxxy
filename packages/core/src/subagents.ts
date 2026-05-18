/**
 * Subagent runtime — turns the SDK's `SubagentSpawner` interface into a
 * working factory that spawns child loops sharing the parent Session's
 * registries.
 *
 * Each child gets:
 *  - Its own `EventLog` (isolated history, no cross-talk).
 *  - Its own `sessionId` + `turnId` (so hooks / tool ctxs see distinct ids).
 *  - The parent's providers, tools (optionally filtered), skills, permissions,
 *    plugin host, and abort signal.
 *
 * As the child runs, this module streams its events into the parent's log
 * as `plugin_event` records with `subagent_*` subtypes — so the TUI, JSON
 * exporters, and other subscribers see live progress without waiting for
 * the child's final message. The captured final assistant message is
 * returned to the spawner caller via the `SubagentResult`.
 */

import type {
  EmittedEvent,
  EventLogReader,
  LoopContext,
  MoxxyEvent,
  SessionId,
  StopReason,
  SubagentResult,
  SubagentSpawner,
  SubagentSpec,
  ToolDef,
  ToolRegistry,
  TurnId,
} from '@moxxy/sdk';
import { asPluginId } from '@moxxy/sdk';
import { EventLog } from './events/log.js';
import { newSessionId, newTurnId } from './events/factory.js';
import type { Session } from './session.js';
import type { ToolRegistry as CoreToolRegistry } from './registries/tools.js';

const SUBAGENT_PLUGIN_ID = asPluginId('@moxxy/subagents');

export interface SubagentRuntime {
  readonly parentSession: Session;
  readonly parentTurnId: TurnId;
  readonly parentSignal: AbortSignal;
  readonly parentModel: string;
}

export function createSubagentSpawner(rt: SubagentRuntime): SubagentSpawner {
  return {
    async spawn(spec) {
      return runOne(rt, spec);
    },
    async spawnAll(specs) {
      return Promise.all(specs.map((s) => runOne(rt, s)));
    },
  };
}

async function runOne(rt: SubagentRuntime, spec: SubagentSpec): Promise<SubagentResult> {
  const { parentSession, parentTurnId, parentSignal, parentModel } = rt;
  const childSessionId = newSessionId();
  const childTurnId = newTurnId();
  const label = spec.label ?? `subagent-${String(childSessionId).slice(-6)}`;
  const requestedStrategy = spec.loopStrategy ?? 'tool-use';

  // Look up the requested strategy in the parent's loop registry. The
  // registry only exposes list() / getActive(), so we scan.
  let strategy = parentSession.loops.list().find((s) => s.name === requestedStrategy);
  let strategyName = requestedStrategy;
  // Fall back to the default tool-use loop if the model invented a name
  // (e.g. "react"). Failing the child outright wastes the user's turn —
  // any reasonable agent task can run on tool-use. We surface the
  // fallback as a non-fatal warning event so the operator sees it.
  if (!strategy) {
    const fallback = parentSession.loops.list().find((s) => s.name === 'tool-use');
    if (fallback) {
      strategy = fallback;
      strategyName = 'tool-use';
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
          message: `unknown loop strategy "${requestedStrategy}" — falling back to "tool-use"`,
        },
      });
    } else {
      // No tool-use either — that's a config error, not a model mistake.
      await emitSubagentStart(parentSession, parentTurnId, label, childSessionId, spec, requestedStrategy);
      const errorMsg = `Subagent failed: unknown loop strategy "${requestedStrategy}" and no fallback available`;
      await emitSubagentCompleted(parentSession, parentTurnId, label, childSessionId, '', 'error', errorMsg);
      return {
        label,
        childSessionId,
        text: '',
        stopReason: 'error' as StopReason,
        error: { message: errorMsg },
      };
    }
  }

  // Filter tools if the spec asks for a restricted set. Otherwise the
  // child shares the parent's full registry directly.
  const toolRegistry: ToolRegistry =
    spec.allowedTools && spec.allowedTools.length > 0
      ? buildFilteredToolRegistry(parentSession.tools, new Set(spec.allowedTools))
      : (parentSession.tools as unknown as ToolRegistry);

  // Child's own event log. We subscribe to it twice:
  //   1) stream every interesting event up to the parent as a
  //      subagent_* plugin_event for live UI rendering.
  //   2) capture the final assistant_message + any fatal error to
  //      synthesize the returned SubagentResult.
  const childLog = new EventLog();

  let finalText = '';
  let finalStopReason: StopReason = 'end_turn';
  let errorMessage: string | null = null;

  const unsubCapture = childLog.subscribe((e) => {
    if (e.type === 'assistant_message') {
      if (e.content) finalText = e.content;
      if (e.stopReason) finalStopReason = e.stopReason;
    } else if (e.type === 'error' && e.kind === 'fatal') {
      errorMessage = e.message;
    }
  });

  const unsubStream = childLog.subscribe((childEvt) =>
    streamChildEventToParent(parentSession, parentTurnId, label, childSessionId, childEvt),
  );

  // Emit "spawned" envelope BEFORE the child starts producing anything.
  await emitSubagentStart(
    parentSession,
    parentTurnId,
    label,
    childSessionId,
    spec,
    strategyName,
  );

  // Seed the child's log with its user_prompt so projection works for
  // tool-use-style strategies (which read user_prompt events from the log).
  await childLog.append({
    type: 'user_prompt',
    sessionId: childSessionId,
    turnId: childTurnId,
    source: 'user',
    text: spec.prompt,
  });

  const provider = parentSession.providers.getActive();

  const childCtx: LoopContext = {
    sessionId: childSessionId,
    turnId: childTurnId,
    model: spec.model ?? parentModel,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    provider,
    tools: toolRegistry,
    skills: parentSession.skills,
    log: childLog as unknown as EventLogReader,
    compactor: parentSession.compactors.getActive(),
    permissions: parentSession.resolver,
    // Intentionally no `approval` — fanning approval gates out to N
    // children in parallel would prompt the user N times. Strategies
    // that absolutely need approval can be invoked at the parent level.
    hooks: parentSession.dispatcher,
    pluginHost: parentSession.pluginHost,
    signal: parentSignal, // child cancels when parent cancels
    maxIterations: spec.maxIterations ?? 50,
    subagents: createSubagentSpawner({
      ...rt,
      parentTurnId: childTurnId, // grand-children attach to this child's turn
    }),
    emit: (event: EmittedEvent): Promise<MoxxyEvent> => childLog.append(event),
  };

  try {
    for await (const _ of strategy.run(childCtx)) {
      void _;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    unsubStream();
    unsubCapture();
  }

  const result: SubagentResult = {
    label,
    childSessionId,
    text: finalText,
    stopReason: errorMessage ? ('error' as StopReason) : finalStopReason,
    ...(errorMessage ? { error: { message: errorMessage } } : {}),
  };

  await emitSubagentCompleted(
    parentSession,
    parentTurnId,
    label,
    childSessionId,
    finalText,
    result.stopReason,
    errorMessage,
  );

  return result;
}

async function emitSubagentStart(
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

async function emitSubagentCompleted(
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

/**
 * Map each interesting child event to a parent `plugin_event` so the TUI
 * can render the subagent's progress in real time. Noisy / book-keeping
 * events (loop_iteration, provider_request, provider_response,
 * assistant_message — covered by the explicit `subagent_completed`) are
 * filtered out to keep the parent log lean.
 */
async function streamChildEventToParent(
  parentSession: Session,
  parentTurnId: TurnId,
  label: string,
  childSessionId: SessionId,
  childEvt: MoxxyEvent,
): Promise<void> {
  let subtype: string | null = null;
  const payload: Record<string, unknown> = {
    label,
    childSessionId: String(childSessionId),
  };

  switch (childEvt.type) {
    case 'assistant_chunk':
      subtype = 'subagent_chunk';
      payload.delta = childEvt.delta;
      break;
    case 'tool_call_requested':
      subtype = 'subagent_tool_call';
      payload.name = childEvt.name;
      payload.input = childEvt.input;
      payload.callId = String(childEvt.callId);
      break;
    case 'tool_result':
      subtype = 'subagent_tool_result';
      payload.callId = String(childEvt.callId);
      payload.ok = childEvt.ok;
      if (childEvt.ok) payload.output = childEvt.output;
      else payload.error = childEvt.error;
      break;
    case 'error':
      subtype = 'subagent_error';
      payload.kind = childEvt.kind;
      payload.message = childEvt.message;
      break;
    case 'abort':
      subtype = 'subagent_abort';
      payload.reason = childEvt.reason;
      break;
    case 'plugin_event': {
      // Bubble nested subagent events too, so a grand-child's progress
      // surfaces all the way up. We strip the nested label-prefix to
      // keep things compact; payload retains the chain via the embedded
      // childSessionId.
      const nestedSubtype = childEvt.subtype;
      if (typeof nestedSubtype === 'string' && nestedSubtype.startsWith('subagent_')) {
        subtype = nestedSubtype;
        const nestedPayload = childEvt.payload;
        if (nestedPayload && typeof nestedPayload === 'object') {
          for (const [k, v] of Object.entries(nestedPayload as Record<string, unknown>)) {
            if (k !== 'label' && k !== 'childSessionId') payload[k] = v;
          }
          // Preserve the chain via a `via` field naming the immediate parent label.
          payload.via = label;
        }
      }
      break;
    }
    default:
      break;
  }

  if (!subtype) return;

  await parentSession.log.append({
    type: 'plugin_event',
    sessionId: parentSession.id,
    turnId: parentTurnId,
    source: 'plugin',
    pluginId: SUBAGENT_PLUGIN_ID,
    subtype,
    payload,
  });
}

function buildFilteredToolRegistry(
  parent: CoreToolRegistry,
  allowed: Set<string>,
): ToolRegistry {
  return {
    list: (): ReadonlyArray<ToolDef> => parent.list().filter((t) => allowed.has(t.name)),
    get: (name: string): ToolDef | undefined =>
      allowed.has(name) ? parent.get(name) : undefined,
    execute: (name, input, signal, opts) => {
      if (!allowed.has(name)) {
        return Promise.reject(new Error(`Tool ${name} not allowed in this subagent`));
      }
      return parent.execute(name, input, signal, opts);
    },
  };
}
