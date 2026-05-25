import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from './loader.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-config-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns empty config when no file is found', async () => {
    const result = await loadConfig({ cwd: tmp, skipUser: true });
    expect(result.config).toEqual({});
    expect(result.sources).toEqual([]);
  });

  it('loads a moxxy.config.js from cwd', async () => {
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.js'),
      `export default { provider: { name: 'anthropic', model: 'sonnet' } };`,
    );
    const result = await loadConfig({ cwd: tmp, skipUser: true });
    expect(result.config.provider?.name).toBe('anthropic');
    expect(result.config.provider?.model).toBe('sonnet');
    expect(result.sources[0]?.scope).toBe('project');
  });

  it('walks upward to find moxxy.config.js', async () => {
    const nested = path.join(tmp, 'a/b/c');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.js'),
      `export default { mode: 'tool-use' };`,
    );
    const result = await loadConfig({ cwd: nested, skipUser: true });
    expect(result.config.mode).toBe('tool-use');
  });

  it('honors explicitPath over upward search', async () => {
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.js'),
      `export default { mode: 'tool-use' };`,
    );
    const custom = path.join(tmp, 'custom.config.js');
    await fs.writeFile(custom, `export default { mode: 'plan-execute' };`);
    const result = await loadConfig({ cwd: tmp, explicitPath: custom, skipUser: true });
    expect(result.config.mode).toBe('plan-execute');
    expect(result.sources[0]?.scope).toBe('explicit');
  });

  it('rejects a config whose schema is invalid', async () => {
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.js'),
      `export default { provider: { name: 42 } };`,
    );
    await expect(loadConfig({ cwd: tmp, skipUser: true })).rejects.toThrow(/Invalid moxxy config/);
  });

  it('rejects a config with no default export', async () => {
    await fs.writeFile(
      path.join(tmp, 'moxxy.config.js'),
      `export const config = {};`,
    );
    await expect(loadConfig({ cwd: tmp, skipUser: true })).rejects.toThrow(/default-export/);
  });
});
