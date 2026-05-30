import type { ModeContext, SessionId, SubagentSpec, TurnId } from '@moxxy/sdk';
import type { EventLog } from '../events/log.js';
import type { SessionRuntime } from '../session-runtime.js';

export interface RetainedChildSession {
  readonly label: string;
  readonly childSessionId: SessionId;
  readonly childTurnId: TurnId;
  readonly childLog: EventLog;
  readonly childCtx: ModeContext;
  readonly spec: SubagentSpec;
  readonly strategy: ReturnType<SessionRuntime['modes']['list']>[number];
  readonly strategyName: string;
  readonly parentSession: SessionRuntime;
  readonly parentTurnId: TurnId;
}

const retained = new Map<string, RetainedChildSession>();

export function registerRetainedChild(session: RetainedChildSession): void {
  retained.set(String(session.childSessionId), session);
}

export function getRetainedChild(childSessionId: SessionId): RetainedChildSession | undefined {
  return retained.get(String(childSessionId));
}

export function releaseRetainedChild(childSessionId: SessionId): void {
  retained.delete(String(childSessionId));
}

export function clearRetainedChildren(): void {
  retained.clear();
}
