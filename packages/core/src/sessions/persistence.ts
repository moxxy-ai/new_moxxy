/**
 * Session persistence — appends each event in `session.log` to a
 * per-session JSONL file under `~/.moxxy/sessions/`, and maintains an
 * `index.json` of session metadata so `moxxy resume` can list and
 * pick a prior session without scanning every event file.
 *
 * Layout:
 *   ~/.moxxy/sessions/
 *     index.json                 array of SessionMeta
 *     <sessionId>.jsonl          one MoxxyEvent per line
 *
 * Atomicity: JSONL appends are best-effort (lose at most the last
 * in-flight event on a crash); index.json uses write-temp-rename so
 * concurrent moxxy processes can't half-corrupt it.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MoxxyEvent, SessionId } from '@moxxy/sdk';
import type { EventLog } from '../events/log.js';

export interface SessionMeta {
  readonly id: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly lastActivity: string;
  readonly eventCount: number;
  /** First 80 chars of the first user_prompt. Used as the picker label. */
  readonly firstPrompt: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

export interface SessionPersistenceOpts {
  readonly sessionId: SessionId;
  readonly cwd: string;
  /** Override the storage root. Defaults to `~/.moxxy/sessions`. */
  readonly dir?: string;
  /** Currently-active provider name — captured into the index for the picker. */
  readonly providerName?: string;
  /** Currently-active model id — captured into the index for the picker. */
  readonly modelId?: string;
}

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.moxxy', 'sessions');
}

/**
 * Attaches a listener that streams every appended event to disk and
 * keeps the index in sync. Returns an `unsubscribe` callback the
 * caller should run on shutdown.
 */
export class SessionPersistence {
  private readonly dir: string;
  private readonly id: string;
  private readonly logPath: string;
  private readonly indexPath: string;
  private meta: SessionMeta;
  private indexUpdateScheduled = false;
  /**
   * In-flight writes are serialized through this promise so the file
   * stays append-ordered even when events arrive faster than the disk
   * can flush.
   */
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: SessionPersistenceOpts) {
    this.dir = opts.dir ?? defaultSessionsDir();
    this.id = String(opts.sessionId);
    this.logPath = path.join(this.dir, `${this.id}.jsonl`);
    this.indexPath = path.join(this.dir, 'index.json');
    const now = new Date().toISOString();
    this.meta = {
      id: this.id,
      cwd: opts.cwd,
      startedAt: now,
      lastActivity: now,
      eventCount: 0,
      firstPrompt: null,
      provider: opts.providerName ?? null,
      model: opts.modelId ?? null,
    };
  }

  /**
   * Subscribe to the log; returns the unsubscribe callback. The first
   * call also writes the initial index row so `moxxy resume` lists
   * the session before any events arrive.
   */
  attach(log: EventLog): () => void {
    void this.ensureDir()
      .then(() => this.ensureLogFile())
      .then(() => this.scheduleIndexWrite())
      .catch(() => undefined);
    const unsub = log.subscribe((event) => {
      if (this.closed) return;
      this.enqueueAppend(event);
    });
    return () => {
      this.closed = true;
      unsub();
      // Flush a final index write so lastActivity reflects the close
      // time even if no events arrived in the last debounce window.
      this.scheduleIndexWrite();
    };
  }

  /**
   * Manually update header fields (provider/model) when the user
   * switches mid-session. The /model picker calls this so the index
   * reflects the active model when the session is resumed.
   */
  updateHeader(patch: { providerName?: string; modelId?: string }): void {
    this.meta = {
      ...this.meta,
      provider: patch.providerName ?? this.meta.provider,
      model: patch.modelId ?? this.meta.model,
    };
    this.scheduleIndexWrite();
  }

  private enqueueAppend(event: MoxxyEvent): void {
    // Update in-memory meta synchronously so multiple events in the
    // same tick share one debounced index write.
    this.meta = {
      ...this.meta,
      eventCount: this.meta.eventCount + 1,
      lastActivity: new Date().toISOString(),
      firstPrompt:
        this.meta.firstPrompt ??
        (event.type === 'user_prompt' ? event.text.slice(0, 80) : null),
    };
    this.scheduleIndexWrite();
    const line = JSON.stringify(event) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.logPath, line, 'utf8'))
      .catch(() => undefined); // never propagate a write error into the listener chain
  }

  private scheduleIndexWrite(): void {
    if (this.indexUpdateScheduled) return;
    this.indexUpdateScheduled = true;
    // 250ms debounce — fast enough that the picker stays current,
    // slow enough that a chatty turn doesn't rewrite the index per
    // assistant_chunk.
    setTimeout(() => {
      this.indexUpdateScheduled = false;
      void this.writeIndex();
    }, 250).unref?.();
  }

  private async writeIndex(): Promise<void> {
    try {
      await this.ensureDir();
      await this.ensureLogFile();
      const all = await readIndex(this.dir);
      const without = all.filter((m) => m.id !== this.meta.id);
      const next = [...without, this.meta].sort((a, b) =>
        b.lastActivity.localeCompare(a.lastActivity),
      );
      await writeJsonAtomic(this.indexPath, next);
    } catch {
      // Index write failures shouldn't bring down a session; the
      // user can always re-resume by id from the filename.
    }
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async ensureLogFile(): Promise<void> {
    const handle = await fs.open(this.logPath, 'a');
    await handle.close();
  }
}

/** Read the session index. Returns [] when the file doesn't exist. */
export async function readIndex(dir = defaultSessionsDir()): Promise<SessionMeta[]> {
  const indexPath = path.join(dir, 'index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const metas = parsed.filter(isSessionMeta);
    const checks = await Promise.all(
      metas.map(async (meta) => {
        try {
          await fs.access(path.join(dir, `${meta.id}.jsonl`));
          return true;
        } catch {
          return false;
        }
      }),
    );
    return metas.filter((_, index) => checks[index]);
  } catch {
    return [];
  }
}

/**
 * Restore a previously-persisted session's events. Returns the full
 * event array suitable for passing into `new EventLog(events)`.
 *
 * Skips malformed lines silently — a single corrupted append shouldn't
 * make the rest of the conversation unreadable.
 */
export async function restoreEvents(
  sessionId: string,
  dir = defaultSessionsDir(),
): Promise<MoxxyEvent[]> {
  const logPath = path.join(dir, `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const events: MoxxyEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as MoxxyEvent);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/** Remove a session's log file and its index entry. */
export async function deleteSession(
  sessionId: string,
  dir = defaultSessionsDir(),
): Promise<void> {
  const logPath = path.join(dir, `${sessionId}.jsonl`);
  await fs.rm(logPath, { force: true });
  const index = await readIndex(dir);
  const without = index.filter((m) => m.id !== sessionId);
  await writeJsonAtomic(path.join(dir, 'index.json'), without);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
}

function isSessionMeta(v: unknown): v is SessionMeta {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.cwd === 'string' &&
    typeof m.startedAt === 'string' &&
    typeof m.lastActivity === 'string' &&
    typeof m.eventCount === 'number'
  );
}
