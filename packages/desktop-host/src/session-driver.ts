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
import type { UserPromptAttachment } from '@moxxy/sdk';

import type { IpcEvents } from '@moxxy/desktop-ipc-contract';
import { openAsk, cancelAsksFor } from './ask-broker.js';
import { buildAttachments } from './attachments.js';

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

    // Forward the runner's permission + approval decisions to the renderer's
    // bottom sheet. Declaring these resolvers tells the runner this client
    // handles permissions/approvals, so loop strategies (plan-execute, BMAD)
    // actually pause and ask instead of assuming. Without them the runner
    // falls back to deny/auto and barrels ahead.
    this.session.setPermissionResolver({
      name: 'desktop-ask',
      check: async (call, ctx) => {
        const res = await openAsk(
          {
            workspaceId,
            kind: 'permission',
            tool: {
              name: call.name,
              input: call.input,
              ...(ctx.toolDescription ? { description: ctx.toolDescription } : {}),
            },
          },
          (channel, payload) => this.send(channel, payload),
        );
        return { mode: res.mode ?? 'deny' };
      },
    });
    this.session.setApprovalResolver({
      name: 'desktop-ask',
      confirm: async (request) => {
        const res = await openAsk(
          { workspaceId, kind: 'approval', approval: request },
          (channel, payload) => this.send(channel, payload),
        );
        // The renderer always returns an `optionId` for an approval. A response
        // WITHOUT one means the ask was cancelled (broker teardown — the driver
        // was disposed / window closed). Cancelling must NOT fall through to the
        // default option (often "approve/proceed"); pick the danger/abort option
        // so a vanished sheet never silently green-lights a risky step.
        const optionId =
          res.optionId ??
          request.options.find((o) => o.danger)?.id ??
          request.defaultOptionId ??
          request.options[0]?.id ??
          'cancel';
        return { optionId, ...(res.text ? { text: res.text } : {}) };
      },
    });

    // Drop everything when the session closes. The supervisor's loop
    // will spin up a fresh driver on the next attach.
    this.session.onClose(() => {
      this.dispose();
    });
  }

  /** True when this driver is bridging `session` — used by the IPC
   *  layer to skip a needless dispose+recreate on a redundant
   *  `connected` pool change (which would otherwise abort an in-flight
   *  turn, e.g. while a plan-execute approval sheet is open). */
  wraps(session: RemoteSession): boolean {
    return this.session === session;
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
          attachments?: ReadonlyArray<UserPromptAttachment>;
        } = {
          signal: controller.signal,
        };
        if (model) opts.model = model;
        if (attachments && attachments.length > 0) {
          // Read each file in the main process and build a real attachment
          // (image base64 / inline text) — the renderer only had the path.
          const built = await buildAttachments(attachments);
          if (built.length > 0) opts.attachments = built;
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
    // Deny any in-flight prompt so the runner doesn't block on a sheet that's
    // about to vanish with the driver.
    cancelAsksFor(this.workspaceId);
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
