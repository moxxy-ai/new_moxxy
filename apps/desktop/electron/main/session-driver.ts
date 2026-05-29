/**
 * Drives a connected [`RemoteSession`] for the renderer:
 *
 *   - Mirrors every event the runner emits onto the
 *     `runner.event` IPC channel.
 *   - Owns the per-turn lifecycle so the renderer can `runTurn`,
 *     `abortTurn`, and (later) `setProvider` / `setMode` through
 *     simple typed commands, without ever holding an AsyncIterable
 *     itself.
 *
 * One driver per connected session — recreated whenever the
 * supervisor transitions back into `connected`.
 */

import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

import type { MoxxyEvent } from '@moxxy/sdk';
import type { RemoteSession } from '@moxxy/runner';

import type { IpcEvents } from '../shared/ipc';

interface ActiveTurn {
  controller: AbortController;
  pump: Promise<void>;
}

export class SessionDriver {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly disposes: Array<() => void> = [];

  constructor(
    private readonly session: RemoteSession,
    private readonly window: BrowserWindow,
    /** Workspace id this driver was created for. Stamped on every
     *  event so the renderer can route it to the right per-workspace
     *  chat state. */
    private readonly workspaceId: string,
  ) {
    // Mirror every event the runner emits.
    const logUnsub = session.log.subscribe((event) => {
      this.send('runner.event', { workspaceId, event });
    });
    this.disposes.push(logUnsub);

    // Drop everything when the session closes. The supervisor's loop
    // will spin up a fresh driver on the next attach.
    session.onClose(() => {
      this.dispose();
    });
  }

  /**
   * Issue a new turn. Returns a synthetic turn id the renderer can
   * pass to `abortTurn` later. Events stream out via `runner.event`.
   * The `turn.complete` channel fires once when the iterable drains
   * (success or error).
   */
  async runTurn(prompt: string, model?: string): Promise<{ turnId: string }> {
    const id = randomUUID();
    const controller = new AbortController();

    const pump = (async () => {
      let error: string | null = null;
      try {
        const opts: { signal: AbortSignal; model?: string } = {
          signal: controller.signal,
        };
        if (model) opts.model = model;
        for await (const event of this.session.runTurn(prompt, opts)) {
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

  /** Snapshot of the runner's SessionInfo. */
  getInfo(): unknown {
    return this.session.getInfo();
  }

  async setProvider(name: string): Promise<void> {
    this.session.providers.setActive(name);
  }

  async setMode(name: string): Promise<void> {
    this.session.modes.setActive(name);
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
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(channel, payload);
  }
}
