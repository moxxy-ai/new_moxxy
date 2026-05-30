/**
 * Workflows handlers.
 *
 * Thin pass-throughs to the runner session's optional `workflows`
 * view (present only when the workflows plugin is loaded). list /
 * setEnabled degrade gracefully when the plugin is absent; run throws
 * a clear error so the renderer can surface it.
 */

import type { RunnerPool } from '../runner-pool';
import { handle, mustSession } from './shared';

export function registerWorkflowsHandlers(pool: RunnerPool): void {
  // ---- Workflows -----------------------------------------------------------

  handle('workflows.list', async () => {
    const session = mustSession(pool);
    const view = session.workflows;
    if (!view) return [];
    return await view.list();
  });
  handle('workflows.setEnabled', async ({ name, enabled }) => {
    const session = mustSession(pool);
    if (session.workflows) await session.workflows.setEnabled(name, enabled);
  });
  handle('workflows.run', async ({ name }) => {
    const session = mustSession(pool);
    if (!session.workflows) throw new Error('workflows plugin not loaded');
    return await session.workflows.run(name);
  });
}
