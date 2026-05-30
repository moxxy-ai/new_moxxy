/**
 * Bridges the runner's `permission.check` / `approval.confirm` requests to the
 * renderer's bottom-sheet UI.
 *
 * Each {@link SessionDriver} installs a permission + approval resolver on its
 * RemoteSession (which makes the runner forward those decisions to us). The
 * resolvers call {@link openAsk}, which emits an `ask.request` to the renderer
 * and parks a promise keyed by `requestId`. When the user picks an option the
 * renderer invokes `ask.respond`, the IPC handler calls {@link answerAsk}, and
 * the parked promise resolves.
 *
 * Module-level state (not per-driver) so the single `ask.respond` IPC handler
 * can route a reply to whichever driver raised it.
 */

import type { AskRequest, AskResponse } from '@moxxy/desktop-ipc-contract';

interface Pending {
  readonly workspaceId: string;
  resolve(response: AskResponse): void;
}

const pending = new Map<string, Pending>();
let counter = 0;

/** A denied/cancelled response — used when a window closes or a session drops
 *  so the runner never blocks forever on an unanswerable prompt. */
const CANCELLED: AskResponse = { mode: 'deny' };

/**
 * Emit an ask to the renderer and await the user's reply. `send` is the
 * driver's window-broadcast so the request reaches every surface bound to that
 * session; the first `ask.respond` for the id wins.
 */
export function openAsk(
  req: Omit<AskRequest, 'requestId'>,
  send: (channel: 'ask.request', payload: AskRequest) => void,
): Promise<AskResponse> {
  const requestId = `ask-${++counter}`;
  return new Promise<AskResponse>((resolve) => {
    pending.set(requestId, { workspaceId: req.workspaceId, resolve });
    send('ask.request', { ...req, requestId });
  });
}

/** Resolve a parked ask with the renderer's response. No-op if unknown/stale. */
export function answerAsk(requestId: string, response: AskResponse): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  p.resolve(response);
}

/** Cancel (deny) every pending ask for a workspace — call on session/driver
 *  teardown so a half-shown prompt doesn't hang the runner. */
export function cancelAsksFor(workspaceId: string): void {
  for (const [id, p] of pending) {
    if (p.workspaceId === workspaceId) {
      pending.delete(id);
      p.resolve(CANCELLED);
    }
  }
}
