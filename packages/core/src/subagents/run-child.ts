import type {
  SessionId,
  StopReason,
  SubagentContinueArgs,
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
import {
  getRetainedChild,
  registerRetainedChild,
  releaseRetainedChild,
  type RetainedChildSession,
} from './registry.js';

export interface SubagentRuntime {
  readonly parentSession: SessionRuntime;
  readonly parentTurnId: TurnId;
  readonly parentSignal: AbortSignal;
  readonly parentModel: string;
}

type ResolvedStrategy =
  | { strategy: ReturnType<SessionRuntime['modes']['list']>[number]; strategyName: string }
  | { failure: SubagentResult };

export async function runChildTurn(args: {
  rt: SubagentRuntime;
  spec: SubagentSpec;
  retainSession: boolean;
}): Promise<SubagentResult> {
  const { rt, spec, retainSession } = args;
  const { parentSession, parentTurnId } = rt;
  const childSessionId = newSessionId();
  const childTurnId = newTurnId();
  const label = spec.label ?? `subagent-${String(childSessionId).slice(-6)}`;
  const requestedStrategy = spec.mode ?? 'tool-use';

  const resolved = await resolveStrategy(
    parentSession,
    parentTurnId,
    label,
    childSessionId,
    spec,
    requestedStrategy,
  );
  if ('failure' in resolved) return resolved.failure;
  const { strategy, strategyName } = resolved;

  const toolRegistry: ToolRegistry =
    spec.allowedTools && spec.allowedTools.length > 0
      ? buildFilteredToolRegistry(parentSession.tools, new Set(spec.allowedTools))
      : (parentSession.tools as unknown as ToolRegistry);

  const childLog = new EventLog();
  const spawner = createSubagentSpawner(rt);
  const childCtx = buildChildContext(
    rt,
    spec,
    childSessionId,
    childTurnId,
    toolRegistry,
    childLog,
    spawner,
  );
  const capture = await executeChildLoop({
    rt,
    spec,
    label,
    childSessionId,
    childTurnId,
    childLog,
    childCtx,
    strategy,
    strategyName,
    emitCompleted: !retainSession,
  });

  if (retainSession) {
    registerRetainedChild({
      label,
      childSessionId,
      childTurnId,
      childLog,
      childCtx,
      spec,
      strategy,
      strategyName,
      parentSession,
      parentTurnId,
    });
  }

  return capture.result;
}

export async function continueChildTurn(args: {
  childSessionId: import('@moxxy/sdk').SessionId;
  prompt: string;
  label?: string;
}): Promise<SubagentResult> {
  const retained = getRetainedChild(args.childSessionId);
  if (!retained) {
    throw new Error(`no retained subagent session for "${String(args.childSessionId)}"`);
  }

  await retained.childLog.append({
    type: 'user_prompt',
    sessionId: retained.childSessionId,
    turnId: retained.childTurnId,
    source: 'user',
    text: args.prompt,
  });

  const rt: SubagentRuntime = {
    parentSession: retained.parentSession,
    parentTurnId: retained.parentTurnId,
    parentSignal: retained.childCtx.signal,
    parentModel: retained.childCtx.model,
  };

  const capture = await executeChildLoop({
    rt,
    spec: retained.spec,
    label: args.label ?? retained.label,
    childSessionId: retained.childSessionId,
    childTurnId: retained.childTurnId,
    childLog: retained.childLog,
    childCtx: retained.childCtx,
    strategy: retained.strategy,
    strategyName: retained.strategyName,
    emitCompleted: true,
    skipStartEvent: true,
  });

  releaseRetainedChild(args.childSessionId);
  return capture.result;
}

async function executeChildLoop(args: {
  rt: SubagentRuntime;
  spec: SubagentSpec;
  label: string;
  childSessionId: ReturnType<typeof newSessionId>;
  childTurnId: TurnId;
  childLog: EventLog;
  childCtx: import('@moxxy/sdk').ModeContext;
  strategy: RetainedChildSession['strategy'];
  strategyName: string;
  emitCompleted: boolean;
  skipStartEvent?: boolean;
}): Promise<{ result: SubagentResult }> {
  const {
    rt,
    spec,
    label,
    childSessionId,
    childTurnId,
    childLog,
    childCtx,
    strategy,
    strategyName,
    emitCompleted,
    skipStartEvent,
  } = args;
  const { parentSession, parentTurnId } = rt;

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

  if (!skipStartEvent) {
    await emitSubagentStart(parentSession, parentTurnId, label, childSessionId, spec, strategyName);
    await childLog.append({
      type: 'user_prompt',
      sessionId: childSessionId,
      turnId: childTurnId,
      source: 'user',
      text: spec.prompt,
    });
  }

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

  if (emitCompleted) {
    await emitSubagentCompleted(
      parentSession,
      parentTurnId,
      label,
      childSessionId,
      capture.text,
      result.stopReason,
      capture.error,
    );
  }

  return { result };
}

async function resolveStrategy(
  parentSession: SessionRuntime,
  parentTurnId: TurnId,
  label: string,
  childSessionId: ReturnType<typeof newSessionId>,
  spec: SubagentSpec,
  requestedStrategy: string,
): Promise<ResolvedStrategy> {
  const exact = parentSession.modes.list().find((s) => s.name === requestedStrategy);
  if (exact) return { strategy: exact, strategyName: requestedStrategy };

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
  spawner: import('@moxxy/sdk').SubagentSpawner,
): import('@moxxy/sdk').ModeContext {
  const { parentSession, parentSignal, parentModel } = rt;
  return {
    sessionId: childSessionId,
    turnId: childTurnId,
    model: spec.model ?? parentModel,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    provider: parentSession.providers.getActive(),
    tools: toolRegistry,
    skills: parentSession.skills,
    log: childLog as unknown as import('@moxxy/sdk').EventLogReader,
    compactor: parentSession.compactors.getActive(),
    cacheStrategy: parentSession.cacheStrategies.getActive(),
    ...(parentSession.elisionSettings ? { elision: parentSession.elisionSettings } : {}),
    ...(parentSession.lazyTools ? { lazyTools: true } : {}),
    permissions: parentSession.resolver,
    hooks: parentSession.dispatcher,
    pluginHost: parentSession.pluginHost,
    signal: parentSignal,
    maxIterations: spec.maxIterations ?? 50,
    subagents: spawner,
    emit: (event) => childLog.append(event),
  };
}

export function createSubagentSpawner(rt: SubagentRuntime): SubagentSpawner {
  return {
    async spawn(spec) {
      return runChildTurn({ rt, spec, retainSession: spec.retainSession === true });
    },
    async spawnAll(specs) {
      return Promise.all(
        specs.map((s) => runChildTurn({ rt, spec: s, retainSession: s.retainSession === true })),
      );
    },
    async continue(args: SubagentContinueArgs) {
      return continueChildTurn(args);
    },
    release(childSessionId: SessionId) {
      releaseRetainedChild(childSessionId);
    },
  };
}
