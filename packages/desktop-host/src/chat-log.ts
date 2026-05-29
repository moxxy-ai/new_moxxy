/**
 * Per-workspace append-only chat log — the durable backend for the
 * renderer's transcript. One NDJSON file per workspace under
 * `~/.moxxy/chats/<workspaceId>.jsonl`, one committed runner event per
 * line.
 *
 * Why this over localStorage (the old backend): appends never
 * re-serialise old events (the localStorage killer was JSON.stringify of
 * the whole array on every turn), there is no ~5 MB origin cap, it
 * survives a renderer crash, and it's trivially greppable. Cursor
 * pagination lets the renderer load only the most-recent slice and fetch
 * older pages on scroll-up.
 *
 * No native dependency — `sqlite` is the upgrade path only if full-text
 * search across thousands of messages later becomes a hard requirement.
 */

import { appendFile, mkdir, readFile, readdir, rm, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MoxxyEvent } from '@moxxy/sdk';

/** Chats directory — env-overridable so tests can point at a tmp dir. */
function chatsDir(): string {
  return process.env['MOXXY_CHATS_DIR'] || path.join(homedir(), '.moxxy', 'chats');
}

/** Confine the filename to the chats dir — workspace ids are desk ids
 *  (safe today), but sanitise defensively so a hostile id can't escape. */
function fileFor(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unnamed';
  return path.join(chatsDir(), `${safe}.jsonl`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readLines(workspaceId: string): Promise<MoxxyEvent[]> {
  let body: string;
  try {
    body = await readFile(fileFor(workspaceId), 'utf8');
  } catch {
    return [];
  }
  const out: MoxxyEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as MoxxyEvent);
    } catch {
      /* skip a corrupt line rather than lose the whole transcript */
    }
  }
  return out;
}

/** Append committed events to the workspace's log. No-op for an empty
 *  batch; creates the dir lazily on first write. */
export async function appendEvents(
  workspaceId: string,
  events: ReadonlyArray<MoxxyEvent>,
): Promise<void> {
  if (events.length === 0) return;
  await mkdir(chatsDir(), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await appendFile(fileFor(workspaceId), lines, 'utf8');
}

/**
 * Load a page of events ending at the `before` line-index cursor (null =
 * the tail). Returns the page oldest-first plus `prevCursor` — the cursor
 * to pass next time to fetch the preceding page, or null once the start
 * of history is reached.
 */
export async function loadSegment(
  workspaceId: string,
  before: number | null,
  limit: number,
): Promise<{ events: MoxxyEvent[]; prevCursor: number | null }> {
  const all = await readLines(workspaceId);
  const end = before === null ? all.length : Math.min(before, all.length);
  const start = Math.max(0, end - limit);
  return { events: all.slice(start, end), prevCursor: start > 0 ? start : null };
}

/** Truncate a workspace's log (Clear conversation). */
export async function clearLog(workspaceId: string): Promise<void> {
  try {
    await rm(fileFor(workspaceId));
  } catch {
    /* already gone */
  }
}

/** Workspace ids that have a persisted log on disk. */
export async function listWorkspaces(): Promise<string[]> {
  try {
    const names = await readdir(chatsDir());
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

/**
 * One-time migration from the legacy localStorage blobs: the renderer
 * parses its `moxxy:chat:*` keys and hands the events up; we seed the
 * NDJSON log for any workspace that doesn't already have one. Idempotent
 * — never clobbers an existing log.
 */
export async function migrate(
  workspaces: ReadonlyArray<{ workspaceId: string; events: ReadonlyArray<MoxxyEvent> }>,
): Promise<void> {
  if (workspaces.length === 0) return;
  await mkdir(chatsDir(), { recursive: true });
  for (const { workspaceId, events } of workspaces) {
    if (events.length === 0) continue;
    if (await exists(fileFor(workspaceId))) continue;
    await appendEvents(workspaceId, events);
  }
}
