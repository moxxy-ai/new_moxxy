/**
 * Chat transcript log (append-only NDJSON).
 *
 * Thin pass-throughs to the `chat-log` store, lazily imported. Append
 * is strictly additive (never re-serialises old events); loadSegment
 * pages backwards from a cursor; clearLog truncates; migrate seeds the
 * NDJSON logs from the renderer's legacy localStorage blobs.
 */

import { handle } from './shared';

export function registerChatHandlers(): void {
  // ---- Chat transcript log (append-only NDJSON) ---------------------------

  handle('chat.append', async ({ workspaceId, events }) => {
    const { appendEvents } = await import('../chat-log');
    await appendEvents(workspaceId, events);
  });
  handle('chat.loadSegment', async ({ workspaceId, before, limit }) => {
    const { loadSegment } = await import('../chat-log');
    return loadSegment(workspaceId, before, limit);
  });
  handle('chat.clearLog', async ({ workspaceId }) => {
    const { clearLog } = await import('../chat-log');
    await clearLog(workspaceId);
  });
  handle('chat.listWorkspaces', async () => {
    const { listWorkspaces } = await import('../chat-log');
    return listWorkspaces();
  });
  handle('chat.migrate', async ({ workspaces }) => {
    const { migrate } = await import('../chat-log');
    await migrate(workspaces);
  });
}
