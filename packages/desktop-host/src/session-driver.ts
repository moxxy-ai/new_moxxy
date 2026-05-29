/**
 * Drives a connected [`RemoteSession`] for the renderer:
 *
 *   - Mirrors every event the runner emits onto the
 *     `runner.event` IPC channel.
 *   - Owns the per-turn lifecycle so the renderer can `runTurn` /
 *     `abortTurn` through simple typed commands, without ever holding an
 *     AsyncIterable itself. (Provider/mode switches go straight to the
 *     RemoteSession in the IPC layer — not through the driver.)
 *
 * One driver per connected session — recreated whenever the
 * supervisor transitions back into `connected`.
 */

import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

import type { RemoteSession } from '@moxxy/runner';

import type { IpcEvents } from '@moxxy/desktop-ipc-contract';

interface ActiveTurn {
  controller: AbortController;
  pump: Promise<void>;
}

export class SessionDriver {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly disposes: Array<() => void> = [];
  /** Every window subscribed to this driver's events. Mutated by
   *  attachWindow / detachWindow so secondary surfaces (focus widget,
   *  future tray pop-up, etc.) receive the same `runner.event` and
   *  `turn.complete` stream as the primary window. */
  private readonly windows = new Set<BrowserWindow>();

  constructor(
    private readonly session: RemoteSession,
    primaryWindow: BrowserWindow,
    /** Workspace id this driver was created for. Stamped on every
     *  event so the renderer can route it to the right per-workspace
     *  chat state. */
    private readonly workspaceId: string,
  ) {
    this.windows.add(primaryWindow);

    // Mirror every event the runner emits.
    const logUnsub = this.session.log.subscribe((event) => {
      this.send('runner.event', { workspaceId, event });
    });
    this.disposes.push(logUnsub);

    // Drop everything when the session closes. The supervisor's loop
    // will spin up a fresh driver on the next attach.
    this.session.onClose(() => {
      this.dispose();
    });
  }

  /** Subscribe a secondary window so it receives every `runner.event`
   *  and `turn.complete` this driver emits. Returns an unsubscribe. */
  attachWindow(win: BrowserWindow): () => void {
    this.windows.add(win);
    const cleanup = (): void => {
      this.windows.delete(win);
      // Also drop the 'closed' listener so detaching a still-open window
      // (e.g. the focus widget re-binding) doesn't leak it.
      win.removeListener('closed', cleanup);
    };
    win.once('closed', cleanup);
    return cleanup;
  }

  /**
   * Issue a new turn. Returns a synthetic turn id the renderer can
   * pass to `abortTurn` later. Events stream out via `runner.event`.
   * The `turn.complete` channel fires once when the iterable drains
   * (success or error).
   */
  async runTurn(
    prompt: string,
    model?: string,
    attachments?: ReadonlyArray<{ path: string; name: string }>,
  ): Promise<{ turnId: string }> {
    const id = randomUUID();
    const controller = new AbortController();

    const pump = (async () => {
      let error: string | null = null;
      try {
        const opts: {
          signal: AbortSignal;
          model?: string;
          attachments?: ReadonlyArray<{
            kind: 'file';
            content: string;
            name: string;
          }>;
        } = {
          signal: controller.signal,
        };
        if (model) opts.model = model;
        if (attachments && attachments.length > 0) {
          opts.attachments = attachments.map((a) => ({
            kind: 'file',
            content: a.path,
            name: a.name,
          }));
        }
        // RemoteSession's runTurn forwards opts.attachments verbatim
        // to the runner's RunTurnParams, where each becomes a
        // UserPromptAttachment on the resulting user_prompt event.
        for await (const event of this.session.runTurn(prompt, opts as never)) {
          // Events also arrive through log.subscribe; this loop just
          // drains so we know when the turn finishes (the AsyncIterable
          // throws on error and returns on clean end).
          void event;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        this.turns.delete(id);
        this.send('runner.turn.complete', {
          workspaceId: this.workspaceId,
          turnId: id,
          error,
        });
      }
    })();

    this.turns.set(id, { controller, pump });
    return { turnId: id };
  }

  abortTurn(turnId: string): void {
    this.turns.get(turnId)?.controller.abort();
  }

  dispose(): void {
    for (const turn of this.turns.values()) turn.controller.abort();
    this.turns.clear();
    for (const fn of this.disposes) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.disposes.length = 0;
  }

  // ---- internals ----

  private send<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
    for (const win of this.windows) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // Renderer can vanish mid-broadcast; nothing to do.
      }
    }
  }
}
