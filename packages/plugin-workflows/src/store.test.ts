import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from './schema.js';
import { WorkflowStore } from './store.js';

let dir: string;
let store: WorkflowStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-wf-'));
  store = new WorkflowStore({ cwd: dir, userDir: path.join(dir, 'user'), projectDir: path.join(dir, 'project') });
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function sample(name: string) {
  return validateWorkflow({ name, description: 'x', steps: [{ id: 'a', prompt: 'go' }] }).workflow!;
}

describe('WorkflowStore CRUD', () => {
  it('creates, lists, and looks up a workflow', async () => {
    const created = await store.create(sample('alpha'), 'user');
    expect(created.scope).toBe('user');
    expect(created.path.endsWith('alpha.yaml')).toBe(true);

    const list = await store.list();
    expect(list.map((w) => w.workflow.name)).toContain('alpha');
    expect(store.lookup('alpha')?.name).toBe('alpha');

    // persisted to disk and rediscovered by a fresh store
    const fresh = new WorkflowStore({ cwd: dir, userDir: path.join(dir, 'user') });
    await fresh.load();
    expect((await fresh.get('alpha'))?.workflow.name).toBe('alpha');
  });

  it('rejects creating a duplicate name', async () => {
    await store.create(sample('beta'), 'user');
    await expect(store.create(sample('beta'), 'user')).rejects.toThrow(/already exists/);
  });

  it('toggles enabled and persists it', async () => {
    await store.create(sample('gamma'), 'user');
    const updated = await store.setEnabled('gamma', false);
    expect(updated?.workflow.enabled).toBe(false);

    const fresh = new WorkflowStore({ cwd: dir, userDir: path.join(dir, 'user') });
    await fresh.load();
    expect((await fresh.get('gamma'))?.workflow.enabled).toBe(false);
  });

  it('deletes a user workflow', async () => {
    await store.create(sample('delta'), 'user');
    const res = await store.delete('delta');
    expect(res.ok).toBe(true);
    expect(await store.get('delta')).toBeUndefined();
  });
});
