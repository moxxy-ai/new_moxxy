import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferencesPath, savePreferences } from './preferences.js';

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-prefs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('preferences', () => {
  it('stores preferences under MOXXY_HOME when it is set', async () => {
    const home = await makeTempHome();
    vi.stubEnv('MOXXY_HOME', home);

    await savePreferences({ providerName: 'fake', model: 'fake-model' });

    expect(preferencesPath()).toBe(path.join(home, 'preferences.json'));
    await expect(fs.readFile(path.join(home, 'preferences.json'), 'utf8')).resolves.toContain('fake-model');
  });
});
