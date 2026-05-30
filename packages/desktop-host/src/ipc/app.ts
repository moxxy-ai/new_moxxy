/**
 * App-level (non per-workspace) handlers: the in-app "Update CLI" flow.
 *
 * The desktop ships a pinned, bundled `@moxxy/cli` but also prefers a
 * writable, user-updated copy under `<userData>/cli` (see the
 * MOXXY_CLI_ENTRY block in the Electron main). These handlers expose the
 * running CLI's version and let the user pull the latest published CLI
 * into that writable location, then restart every runner so the new
 * binary is used immediately — no full app update.
 */

import { app, BrowserWindow as BrowserWindowApi } from 'electron';

import type { RunnerPool } from '../runner-pool';
import { getCliVersion, updateCli } from '../installer';
import { preferredCliEntry } from '../cli-resolver';
import { handle } from './shared';

export function registerAppHandlers(pool: RunnerPool): void {
  handle('app.cliInfo', async () => ({
    version: getCliVersion(),
    path: process.env.MOXXY_CLI_ENTRY ?? null,
  }));

  handle('app.updateCli', async () => {
    const target = BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    if (!target) throw new Error('no window to stream update progress to');

    const userData = app.getPath('userData');
    const code = await updateCli(userData, target);

    if (code === 0) {
      // Re-point at the freshly-installed copy if it now exists, using the
      // same preference order as the boot block, then restart every runner
      // so the supervision loop re-resolves the CLI and respawns `serve`
      // against the new binary.
      const entry = preferredCliEntry(userData, process.resourcesPath ?? '');
      if (entry) process.env.MOXXY_CLI_ENTRY = entry;
      await Promise.all(pool.list().map((e) => e.supervisor.restart()));
    }

    return { code, version: getCliVersion() };
  });
}
