/**
 * Subagent runtime — turns the SDK's `SubagentSpawner` interface into a
 * working factory that spawns child modes sharing the parent Session's
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
  ModeContext,
  MoxxyEvent,
  StopReason,
  SubagentResult,
  SubagentSpawner,
  SubagentSpec,
  ToolRegistry,
  TurnId,
} from '@moxxy/sdk';
import { EventLog } from '../events/log.js';
import { newSessionId, newTurnId } from '../events/factory.js';
import type { SessionRuntime } from '../session-runtime.js';
import {
  emitSubagentCompleted,
  emitSubagentStart,
  emitSubagentWarning,
  streamChildEventToParent,
} from './events.js';
import { buildFilteredToolRegistry } from './tools.js';

export interface SubagentRuntime {
  readonly parentSession: SessionRuntime;
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
  const { parentSession, parentTurnId } = rt;
  const childSessionId = newSessionId();
  const childTurnId = newTurnId();
  const label = spec.label ?? `subagent-${String(childSessionId).slice(-6)}`;
  const requestedStrategy = spec.mode ?? 'tool-use';

  const resolved = await resolveStrategy(parentSession, parentTurnId, label, childSessionId, spec, requestedStrategy);
  if ('failure' in resolved) return resolved.failure;
  const { strategy, strategyName } = resolved;

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
  const capture = { text: '', stopReason: 'end_turn' as StopReason, error: null as string | null };

  const unsubCapture = childLog.subscribe((e) => {
    if (e.type === 'assistant_message') {
      if (e.content) capture.text = e.content;
      if (e.stopReason) capture.stopReason = e.stopReason;
    } else if (e.type === 'error' && e.kind === 'fatal') {
      capture.error = e.message;
    }
  });

  const unsubStream = childLog.subscribe((childEvt) =>
    streamChildEventToParent(parentSession, parentTurnId, label, childSessionId, childEvt),
  );

  await emitSubagentStart(parentSession, parentTurnId, label, childSessionId, spec, strategyName);

  // Seed the child's log with its user_prompt so projection works for
  // tool-use-style strategies (which read user_prompt events from the log).
  await childLog.append({
    type: 'user_prompt',
    sessionId: childSessionId,
    turnId: childTurnId,
    source: 'user',
    text: spec.prompt,
  });

  const childCtx = buildChildContext(rt, spec, childSessionId, childTurnId, toolRegistry, childLog);

  try {
    for await (const _ of strategy.run(childCtx)) {
      void _;
    }
  } catch (err) {
    capture.error = err instanceof Error ? err.message : String(err);
  } finally {
    unsubStream();
    unsubCapture();
  }

  const result: SubagentResult = {
    label,
    childSessionId,
    text: capture.text,
    stopReason: capture.error ? ('error' as StopReason) : capture.stopReason,
    ...(capture.error ? { error: { message: capture.error } } : {}),
  };

  await emitSubagentCompleted(
    parentSession,
    parentTurnId,
    label,
    childSessionId,
    capture.text,
    result.stopReason,
    capture.error,
  );

  return result;
}

type ResolvedStrategy =
  | { strategy: ReturnType<SessionRuntime['modes']['list']>[number]; strategyName: string }
  | { failure: SubagentResult };

async function resolveStrategy(
  parentSession: SessionRuntime,
  parentTurnId: TurnId,
  label: string,
  childSessionId: ReturnType<typeof newSessionId>,
  spec: SubagentSpec,
  requestedStrategy: string,
): Promise<ResolvedStrategy> {
  // Look up the requested strategy in the parent's loop registry. The
  // registry only exposes list() / getActive(), so we scan.
  const exact = parentSession.modes.list().find((s) => s.name === requestedStrategy);
  if (exact) return { strategy: exact, strategyName: requestedStrategy };

  // Fall back to the default tool-use mode if the model invented a name
  // (e.g. "react"). Failing the child outright wastes the user's turn —
  // any reasonable agent task can run on tool-use. We surface the
  // fallback as a non-fatal warning event so the operator sees it.
  const fallback = parentSession.modes.list().find((s) => s.name === 'tool-use');
  if (fallback) {
    await emitSubagentWarning(
      parentSession,
      parentTurnId,
      label,
      childSessionId,
      `unknown mode "${requestedStrategy}" — falling back to "tool-use"`,
    );
    return { strategy: fallback, strategyName: 'tool-use' };
  }

  // No tool-use either — that's a config error, not a model mistake.
  await emitSubagentStart(parentSession, parentTurnId, label, childSessionId, spec, requestedStrategy);
  const errorMsg = `Subagent failed: unknown mode "${requestedStrategy}" and no fallback available`;
  await emitSubagentCompleted(parentSession, parentTurnId, label, childSessionId, '', 'error', errorMsg);
  return {
    failure: {
      label,
      childSessionId,
      text: '',
      stopReason: 'error' as StopReason,
      error: { message: errorMsg },
    },
  };
}

function buildChildContext(
  rt: SubagentRuntime,
  spec: SubagentSpec,
  childSessionId: ReturnType<typeof newSessionId>,
  childTurnId: TurnId,
  toolRegistry: ToolRegistry,
  childLog: EventLog,
): ModeContext {
  const { parentSession, parentSignal, parentModel } = rt;
  return {
    sessionId: childSessionId,
    turnId: childTurnId,
    model: spec.model ?? parentModel,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    provider: parentSession.providers.getActive(),
    tools: toolRegistry,
    skills: parentSession.skills,
    log: childLog as unknown as EventLogReader,
    compactor: parentSession.compactors.getActive(),
    cacheStrategy: parentSession.cacheStrategies.getActive(),
    ...(parentSession.elisionSettings ? { elision: parentSession.elisionSettings } : {}),
    ...(parentSession.lazyTools ? { lazyTools: true } : {}),
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
}
