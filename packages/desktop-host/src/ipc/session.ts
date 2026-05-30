/**
 * Per-workspace session commands.
 *
 * Turn lifecycle (runTurn / abortTurn) routes through the workspace's
 * {@link SessionDriver} in the {@link drivers} registry; provider / mode
 * switches and slash commands talk straight to the {@link RemoteSession}
 * (then settle via {@link waitForSessionState}). Voice (hasTranscriber /
 * transcribe) is served by the in-process Codex transcriber rather than
 * a runner round-trip, mirroring the TUI's self-host setup.
 *
 * Every command accepts an optional `workspaceId` and defaults to the
 * pool's active workspace so the renderer can target a background
 * workspace without foregrounding it.
 */

import { dialog, BrowserWindow as BrowserWindowApi } from 'electron';

import type { RunnerPool } from '../runner-pool';
import { persistImageBlob } from '../attachments.js';
import {
  drivers,
  getInProcessPlugins,
  handle,
  mustDriver,
  mustRemote,
  resolveSupervisor,
  waitForSessionState,
} from './shared';

export function registerSessionHandlers(pool: RunnerPool): void {
  // ---- Session (per-workspace) --------------------------------------------

  handle('session.info', async (args) => {
    const sup = resolveSupervisor(pool, args?.workspaceId);
    const session = sup?.remote();
    return session ? session.getInfo() : null;
  });
  handle('session.runTurn', async ({ workspaceId, prompt, model, attachments }) => {
    const id = workspaceId ?? pool.activeWorkspaceId();
    if (!id) throw new Error('no active workspace');
    const driver = mustDriver(id);
    return driver.runTurn(prompt, model, attachments);
  });
  handle('session.abortTurn', async ({ workspaceId, turnId }) => {
    const id = workspaceId ?? pool.activeWorkspaceId();
    if (!id) return;
    drivers.get(id)?.abortTurn(turnId);
  });
  handle('session.setProvider', async ({ workspaceId, provider }) => {
    const session = mustRemote(pool, workspaceId);
    session.providers.setActive(provider);
    await waitForSessionState(session, (info) => info.activeProvider === provider);
    // Re-emit the connection phase so the renderer sees the new activeProvider
    // — otherwise the onboarding `connectedWithoutProvider` gate never clears.
    resolveSupervisor(pool, workspaceId)?.refreshConnectedInfo();
  });
  handle('session.setMode', async ({ workspaceId, mode }) => {
    const session = mustRemote(pool, workspaceId);
    session.modes.setActive(mode);
    await waitForSessionState(session, (info) => info.activeMode === mode);
    resolveSupervisor(pool, workspaceId)?.refreshConnectedInfo();
  });
  handle('session.runCommand', async ({ workspaceId, name, args }) => {
    const session = mustRemote(pool, workspaceId);
    const def = session.commands.get(name);
    if (!def) return { kind: 'error', message: `unknown command: /${name}` } as const;
    // The runner doesn't care about the channel name beyond logging,
    // but some command handlers gate behaviour on it. "desktop"
    // mirrors the TUI's "tui" convention and keeps things grep-able.
    const result = await def.handler({
      channel: 'desktop',
      sessionId: session.getInfo().sessionId,
      args,
      session: session as unknown as Parameters<typeof def.handler>[0]['session'],
    });
    return result;
  });
  handle('session.hasTranscriber', async () => {
    // Voice is wired through the desktop's *in-process* Codex
    // transcriber (mirrors the TUI's self-host setup: same vault,
    // same plugin class). Affordance gating: probe the vault for
    // ANY entry under the Codex OAuth namespace
    // (`oauth/openai-codex/*`) — same key prefix the Codex login
    // command writes to. If something's stored, the user has a
    // login → show the mic.
    try {
      const { vault } = getInProcessPlugins();
      // Stored Codex creds are written under `oauth/openai-codex/...`
      // by `moxxy login openai-codex`. We check the canonical
      // refresh-token key; the transcriber's own resolver does the
      // detailed validation when transcribe() is called.
      const refresh = await vault.get('oauth/openai-codex/refresh_token');
      return refresh != null;
    } catch {
      return false;
    }
  });
  handle('session.transcribe', async ({ audioBase64, mimeType }) => {
    // Run the transcribe through the in-process Codex transcriber —
    // same plugin class, same vault, identical to the TUI's voice
    // path. No round-trip through the runner socket needed (and no
    // RemoteSession.setActive throw to work around).
    const { transcriber } = getInProcessPlugins();
    const audio = Buffer.from(audioBase64, 'base64');
    const result = await transcriber.transcribe(
      audio,
      mimeType ? { mimeType } : undefined,
    );
    return result.text;
  });
  handle('session.pickAttachment', async () => {
    const window =
      BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window ?? null!, {
      title: 'Attach a file to the next prompt',
      properties: ['openFile'],
      // Restrict to what the agent can actually use: images + text/code.
      // buildAttachments is the real gate (it drops binary/oversized), but
      // the filter steers the picker so the user doesn't pick a 4 GB video.
      filters: [
        {
          name: 'Attachable files',
          extensions: [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
            'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'sql',
            'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
            'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'html', 'css', 'scss',
            'xml', 'toml', 'ini', 'env', 'conf',
          ],
        },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });
  handle('session.saveImageAttachment', async ({ dataBase64, mediaType, name }) =>
    // The renderer can't write files, so a pasted/dropped image's bytes
    // are stashed to a temp file here; the returned path then rides the
    // same attachment pipeline as a picked file.
    persistImageBlob(dataBase64, mediaType, name),
  );
}
