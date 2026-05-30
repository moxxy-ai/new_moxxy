/**
 * Desk (workspace) CRUD.
 *
 * Persistence lives in the {@link DeskStore}; these handlers also keep
 * the {@link RunnerPool} in step — creating / switching a desk spins up
 * or foregrounds its supervisor, and removing one tears its runner
 * down (then ensures *some* runner stays alive for the next active
 * desk). The native folder picker rounds out the create flow.
 */

import { dialog, BrowserWindow as BrowserWindowApi } from 'electron';

import type { RunnerPool } from '../runner-pool';
import type { DeskStore } from '../desks';
import { handle } from './shared';

export function registerDesksHandlers(pool: RunnerPool, desks: DeskStore): void {
  // ---- Desks --------------------------------------------------------------

  handle('desks.list', async () => {
    const list = await desks.list();
    const active = await desks.getActive();
    return { desks: list, activeId: active?.id ?? null };
  });
  handle('desks.create', async ({ name, cwd }) => desks.create({ name, cwd }));
  handle('desks.remove', async ({ id }) => {
    await desks.remove(id);
    await pool.remove(id);
    const active = await desks.getActive();
    if (active) await pool.getOrCreate(active.id, active.cwd);
  });
  handle('desks.setActive', async ({ id }) => {
    await desks.setActive(id);
    const active = await desks.getActive();
    if (active) {
      await pool.getOrCreate(active.id, active.cwd);
      pool.setActive(active.id);
    }
  });
  handle('desks.rename', async ({ id, name }) => desks.rename(id, name));
  handle('desks.pickFolder', async () => {
    const window =
      BrowserWindowApi.getFocusedWindow() ?? BrowserWindowApi.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window ?? null!, {
      title: 'Bind a desk to a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });
}
