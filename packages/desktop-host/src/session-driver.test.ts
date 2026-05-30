/**
 * Regression: a plan-execute turn parks for many seconds on its
 * human-in-the-loop approval. A redundant `connected` pool change must
 * NOT dispose+recreate the driver underneath that turn — doing so aborts
 * the runner-side turn, and the post-approval execution step then reports
 * "did not complete cleanly".
 *
 * We drive a real RunnerServer + RemoteSession running the real
 * plan-execute mode, park the turn on its approval gate, and assert:
 *   - `driver.wraps(session)` is true for the live session (the guard the
 *     IPC layer uses to skip a needless recreate), and
 *   - disposing the driver mid-approval aborts the turn (the hazard the
 *     guard avoids).
 */
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { Session, autoAllowResolver, silentLogger } from '@moxxy/core';
import { definePlugin, defineProvider, defineTool, z } from '@moxxy/sdk';
import { FakeProvider, textReply, toolUseReply } from '@moxxy/testing';
import { planExecuteModePlugin, PLAN_EXECUTE_MODE_NAME } from '@moxxy/mode-plan-execute';
import {
  startRunnerServer,
  connectRemoteSession,
  type RunnerServer,
  type RemoteSession,
} from '@moxxy/runner';
import type { BrowserWindow } from 'electron';
import { SessionDriver } from './session-driver';
import { answerAsk } from './ask-broker';
import type { AskRequest } from '@moxxy/desktop-ipc-contract';

function tmpSocket(): string {
  return path.join(os.tmpdir(), `moxxy-driver-${Math.random().toString(36).slice(2, 10)}.sock`);
}

/** Minimal stand-in for an Electron BrowserWindow — SessionDriver only
 *  touches webContents.send / isDestroyed / once / removeListener. */
function fakeWindow(): {
  win: BrowserWindow;
  sent: Array<{ channel: string; payload: unknown }>;
} {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const emitter = new EventEmitter();
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
    once: (ev: string, fn: () => void) => emitter.once(ev, fn),
    removeListener: (ev: string, fn: () => void) => emitter.removeListener(ev, fn),
  };
  return { win: win as unknown as BrowserWindow, sent };
}

const servers: RunnerServer[] = [];
const remotes: RemoteSession[] = [];

afterEach(async () => {
  await Promise.all(remotes.splice(0).map((r) => r.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function buildSession(provider: FakeProvider): Session {
  const session = new Session({
    cwd: process.cwd(),
    logger: silentLogger,
    permissionResolver: autoAllowResolver,
  });
  session.pluginHost.registerStatic(
    definePlugin({
      name: 'driver-test-shim',
      providers: [
        defineProvider({
          name: provider.name,
          models: [...provider.models],
          createClient: () => provider,
        }),
      ],
      tools: [
        defineTool({
          name: 'Write',
          description: 'write a file',
          inputSchema: z.object({ file_path: z.string(), content: z.string() }),
          permission: { action: 'prompt' },
          handler: (input) => `wrote ${input.file_path}`,
        }),
      ],
    }),
  );
  session.providers.setActive(provider.name);
  session.pluginHost.registerStatic(planExecuteModePlugin);
  session.modes.setActive(PLAN_EXECUTE_MODE_NAME);
  return session;
}

async function servePlanExecute(): Promise<RemoteSession> {
  const provider = new FakeProvider({
    script: [
      textReply('PLAN:\n1. Write step1.md\n2. Write step2.md'),
      toolUseReply('Write', { file_path: 'step1.md', content: 'a' }, 'c1'),
      textReply('step 1 done'),
      toolUseReply('Write', { file_path: 'step2.md', content: 'b' }, 'c2'),
      textReply('step 2 done'),
    ],
  });
  const socketPath = tmpSocket();
  const server = await startRunnerServer(buildSession(provider), { socketPath });
  servers.push(server);
  const remote = await connectRemoteSession({ socketPath, role: 'driver-test' });
  remotes.push(remote);
  return remote;
}

describe('SessionDriver plan-execute survival', () => {
  it('wraps() identifies the live session so the IPC layer can skip a recreate', async () => {
    const remote = await servePlanExecute();
    const { win } = fakeWindow();
    const driver = new SessionDriver(remote, win, 'ws');
    expect(driver.wraps(remote)).toBe(true);
    const other = await servePlanExecute();
    expect(driver.wraps(other)).toBe(false);
    driver.dispose();
  });

  it('runs every plan step to completion when the driver is left in place', async () => {
    const remote = await servePlanExecute();
    const { win, sent } = fakeWindow();
    // The driver installs the broker-backed resolvers; the renderer (here,
    // this test) answers each ask.request through `answerAsk`. Auto-approve
    // the plan and allow every permission, mirroring a user clicking through.
    const stop = autoAnswer(sent, (req) =>
      req.kind === 'approval' ? { optionId: 'approve' } : { mode: 'allow_session' },
    );
    const driver = new SessionDriver(remote, win, 'ws');

    const { turnId } = await driver.runTurn('do the work');
    expect(turnId).toBeTruthy();

    await waitFor(() =>
      remote.log
        .slice()
        .some((e) => e.type === 'plugin_event' && e.subtype === 'plan_completed'),
    );
    const errs = remote.log.ofType('error');
    expect(errs).toHaveLength(0);
    stop();
    driver.dispose();
  });

  it('disposing the driver while parked on the approval aborts the turn (the hazard wraps() prevents)', async () => {
    const remote = await servePlanExecute();
    const { win, sent } = fakeWindow();
    // Auto-allow permissions, but DO NOT answer the approval ask — leave the
    // turn parked at the human-in-the-loop gate, exactly as if the user were
    // still reading the plan in the bottom sheet.
    let approvalRaised = false;
    const stop = autoAnswer(sent, (req) => {
      if (req.kind === 'approval') {
        approvalRaised = true;
        return null; // park
      }
      return { mode: 'allow_session' };
    });
    const driver = new SessionDriver(remote, win, 'ws');
    await driver.runTurn('do the work');

    // Wait until the approval gate is reached (planning phase done).
    await waitFor(() => approvalRaised);

    // A bad pool change disposes the driver mid-approval. dispose() cancels
    // the pending ask AND aborts the in-flight turn — the runner-side turn
    // ends and the post-approval step can't run.
    driver.dispose();

    // The turn must NOT reach plan_completed.
    await waitFor(() => {
      const aborted = remote.log.slice().some((e) => e.type === 'abort');
      const completed = remote.log
        .slice()
        .some((e) => e.type === 'plugin_event' && e.subtype === 'plan_completed');
      const erred = remote.log.ofType('error').length > 0;
      return aborted || completed || erred;
    });
    const completed = remote.log
      .slice()
      .some((e) => e.type === 'plugin_event' && e.subtype === 'plan_completed');
    expect(completed).toBe(false);
    stop();
  });
});

/**
 * Poll the fake window's outbound IPC for `ask.request` frames and answer
 * each one through the broker (`answerAsk`), the same path the renderer's
 * `ask.respond` IPC handler uses. Returning `null` from `respond` parks the
 * ask (simulates a user still deciding). Returns a stop() to end polling.
 */
function autoAnswer(
  sent: Array<{ channel: string; payload: unknown }>,
  respond: (req: AskRequest) => { mode?: string; optionId?: string; text?: string } | null,
): () => void {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of sent) {
      if (frame.channel !== 'ask.request') continue;
      const req = frame.payload as AskRequest;
      if (answered.has(req.requestId)) continue;
      const reply = respond(req);
      if (reply === null) {
        answered.add(req.requestId); // park, but don't re-evaluate
        continue;
      }
      answered.add(req.requestId);
      answerAsk(req.requestId, reply as never);
    }
  }, 3);
  return () => clearInterval(timer);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
