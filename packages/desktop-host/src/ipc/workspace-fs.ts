/**
 * Workspace filesystem browsing.
 *
 * `workspace.listDir` resolves the requested directory against the
 * targeted desk's cwd (looked up by workspace id so background
 * workspaces can be browsed too); {@link listDir} enforces the "stay
 * below the cwd" guard so the renderer can never traverse out of the
 * workspace.
 */

import type { DeskStore } from '../desks';
import { handle } from './shared';

export function registerWorkspaceFsHandlers(desks: DeskStore): void {
  // ---- Workspace filesystem browsing --------------------------------------

  handle('workspace.listDir', async ({ workspaceId, path: relPath }) => {
    const { listDir } = await import('../workspace-fs');
    // Look up the cwd by the workspace id so background workspaces
    // can be browsed too; fall back to the active desk.
    const all = await desks.list();
    const desk = all.find((d) => d.id === workspaceId) ?? (await desks.getActive());
    if (!desk) {
      return { cwd: process.cwd(), path: '.', entries: [] };
    }
    return listDir(desk.cwd, relPath);
  });
}
