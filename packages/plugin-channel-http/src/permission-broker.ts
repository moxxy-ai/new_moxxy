import { randomUUID } from 'node:crypto';
import type { Session } from '@moxxy/core';
import {
  asPluginId,
  type PendingToolCall,
  type PermissionContext,
  type PermissionDecision,
  type PermissionResolver,
} from '@moxxy/sdk';

export const PERMISSION_REQUESTED_SUBTYPE = 'permission.requested';
export const PERMISSION_RESOLVED_SUBTYPE = 'permission.resolved';

const PERMISSION_PLUGIN_ID = asPluginId('@moxxy/plugin-channel-http');

type PendingPermission = {
  readonly call: PendingToolCall;
  readonly agentId: string;
  readonly resolve: (decision: PermissionDecision) => void;
};

export class HttpPermissionBroker implements PermissionResolver {
  readonly name = 'http-interactive';
  private session: Session | null = null;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly allowSessionTools = new Set<string>();
  private readonly agentBySessionId = new Map<string, string>();

  attachSession(session: Session): void {
    this.session = session;
    this.registerAgentSession(String(session.id), 'session');
  }

  registerAgentSession(sessionId: string, agentId: string): void {
    this.agentBySessionId.set(sessionId, agentId);
  }

  unregisterAgentSession(sessionId: string): void {
    this.agentBySessionId.delete(sessionId);
  }

  async check(call: PendingToolCall, ctx: PermissionContext): Promise<PermissionDecision> {
    if (this.allowSessionTools.has(call.name)) {
      return { mode: 'allow_session', reason: 'allow_session previously granted' };
    }
    if (!this.session) {
      return { mode: 'deny', reason: 'HTTP permission broker is not attached to a session' };
    }

    const requestId = `perm-${randomUUID()}`;
    const agentId = this.agentBySessionId.get(ctx.sessionId) ?? 'session';
    await this.session.log.append({
      type: 'plugin_event',
      sessionId: this.session.id,
      turnId: this.session.startTurn().turnId,
      source: 'plugin',
      pluginId: PERMISSION_PLUGIN_ID,
      subtype: PERMISSION_REQUESTED_SUBTYPE,
      payload: {
        request_id: requestId,
        agent_id: agentId,
        tool_name: call.name,
        tool_description: ctx.toolDescription ?? null,
        call: {
          call_id: String(call.callId ?? ''),
          name: call.name,
          input: call.input,
        },
        created_at: new Date().toISOString(),
      },
    });

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, { call, agentId, resolve });
    });
  }

  async decide(requestId: string, decision: PermissionDecision): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending || !this.session) return false;
    this.pending.delete(requestId);

    if (decision.mode === 'allow_session' || decision.mode === 'allow_always') {
      this.allowSessionTools.add(pending.call.name);
    }
    if (decision.mode === 'allow_always') {
      await this.session.permissions
        .addAllow({ name: pending.call.name, reason: 'allow_always via Virtual Office' })
        .catch(() => undefined);
    }

    pending.resolve(decision);
    await this.session.log.append({
      type: 'plugin_event',
      sessionId: this.session.id,
      turnId: this.session.startTurn().turnId,
      source: 'plugin',
      pluginId: PERMISSION_PLUGIN_ID,
      subtype: PERMISSION_RESOLVED_SUBTYPE,
      payload: {
        request_id: requestId,
        agent_id: pending.agentId,
        tool_name: pending.call.name,
        mode: decision.mode,
        reason: decision.reason ?? null,
      },
    });
    return true;
  }

  abortAll(reason = 'permission broker stopped'): void {
    for (const [requestId, pending] of [...this.pending.entries()]) {
      this.pending.delete(requestId);
      pending.resolve({ mode: 'deny', reason });
    }
  }
}
