import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventLog } from '../events/log.js';
import { SessionPersistence, readIndex, restoreEvents, type SessionMeta } from './persistence.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-sessions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function meta(id: string, eventCount = 0): SessionMeta {
  return {
    id,
    cwd: '/tmp/project',
    startedAt: '2026-05-21T00:00:00.000Z',
    lastActivity: '2026-05-21T00:00:00.000Z',
    eventCount,
    firstPrompt: eventCount > 0 ? 'hello' : null,
    provider: null,
    model: null,
  };
}

describe('SessionPersistence', () => {
  it('readIndex ignores rows whose event log file is missing', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'present.jsonl'), '', 'utf8');
    await fs.writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify([meta('missing'), meta('present')], null, 2),
      'utf8',
    );

    await expect(readIndex(dir)).resolves.toEqual([meta('present')]);
  });

  it('creates a resumable empty event log when a session is indexed before any events', async () => {
    const dir = await makeTempDir();
    const id = '01EMPTYSESSION000000000000';
    const persistence = new SessionPersistence({ sessionId: id as never, cwd: '/tmp/project', dir });
    const detach = persistence.attach(new EventLog());

    await waitForFile(path.join(dir, `${id}.jsonl`));
    await expect(restoreEvents(id, dir)).resolves.toEqual([]);

    detach();
  });
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
