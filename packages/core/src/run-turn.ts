import type { EmittedEvent, ModeContext, MoxxyEvent, RunTurnOptions } from '@moxxy/sdk';
import type { SessionRuntime } from './session-runtime.js';
import { createSubagentSpawner } from './subagents.js';

// `RunTurnOptions` now lives in `@moxxy/sdk` so the runner client (which has
// no `Session`) can reference it. Re-exported here to keep the historical
// `@moxxy/core` import path working.
export type { RunTurnOptions } from '@moxxy/sdk';

export async function* runTurn(
  session: SessionRuntime,
  prompt: string,
  opts: RunTurnOptions = {},
): AsyncIterable<MoxxyEvent> {
  // Mint the turnId first so the subscriber below can filter by it. Without
  // the filter, concurrent runTurn() calls on the same Session would each
  // observe every event from every other turn (the EventLog has one global
  // listener set), causing cross-talk for hosts like the HTTP channel that
  // serve multiple turns in parallel.
  // Use a caller-supplied turnId when present (the runner mints it up front so
  // it can return the id before the turn runs); otherwise mint one here.
  const turnId = opts.turnId ?? session.startTurn().turnId;
  const provider = session.providers.getActive();
  const model = opts.model ?? provider.models[0]?.id ?? 'default';

  const queue: MoxxyEvent[] = [];
  const waiters: Array<() => void> = [];
  let done = false;
  let strategyError: unknown = null;

  const wake = (): void => waiters.shift()?.();
  const unsubscribe = session.log.subscribe((event) => {
    if (event.turnId !== turnId) return;
    queue.push(event);
    wake();
  });

  let strategyPromise: Promise<void> | null = null;

  try {
    await session.log.append({
      type: 'user_prompt',
      sessionId: session.id,
      turnId,
      source: 'user',
      text: prompt,
      ...(opts.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments }
        : {}),
    });

    const strategy = session.modes.getActive();
    // Combine the session's signal with the per-turn one (if provided)
    // so either firing cancels the turn.
    const effectiveSignal = opts.signal
      ? AbortSignal.any([session.signal, opts.signal])
      : session.signal;
    const ctx: ModeContext = {
      sessionId: session.id,
      turnId,
      model,
      systemPrompt: opts.systemPrompt,
      provider,
      tools: session.tools,
      skills: session.skills,
      log: session.log,
      compactor: session.compactors.getActive(),
      cacheStrategy: session.cacheStrategies.getActive(),
      ...(session.elisionSettings ? { elision: session.elisionSettings } : {}),
      ...(session.lazyTools ? { lazyTools: true } : {}),
      permissions: session.resolver,
      ...(session.approvalResolver ? { approval: session.approvalResolver } : {}),
      hooks: session.dispatcher,
      pluginHost: session.pluginHost,
      signal: effectiveSignal,
      maxIterations: opts.maxIterations,
      subagents: createSubagentSpawner({
        parentSession: session,
        parentTurnId: turnId,
        parentSignal: effectiveSignal,
        parentModel: model,
      }),
      emit: (event: EmittedEvent) => session.log.append(event),
    };

    const turnStartCtx = { ...session.appContext(), turnId, iteration: 0 };

    strategyPromise = (async () => {
      try {
        await session.dispatcher.dispatchTurnStart(turnStartCtx);
        for await (const _ of strategy.run(ctx)) {
          // Events are surfaced via the log subscription above.
          void _;
        }
        await session.dispatcher.dispatchTurnEnd(turnStartCtx);
      } catch (err) {
        strategyError = err;
      } finally {
        done = true;
        wake();
      }
    })();

    while (true) {
      while (queue.length > 0) yield queue.shift() as MoxxyEvent;
      if (done) break;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  } finally {
    unsubscribe();
    if (strategyPromise) await strategyPromise;
  }

  if (strategyError) throw strategyError;
}

export async function collectTurn(
  session: SessionRuntime,
  prompt: string,
  opts: RunTurnOptions = {},
): Promise<ReadonlyArray<MoxxyEvent>> {
  const events: MoxxyEvent[] = [];
  for await (const event of runTurn(session, prompt, opts)) events.push(event);
  return events;
}
