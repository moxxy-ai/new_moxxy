import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { discoverPlugins } from './discovery.js';
import { createPluginLoader } from './loader.js';

let tmp: string;
let cwd: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-discover-'));
  cwd = path.join(tmp, 'project');
  await fs.mkdir(path.join(cwd, 'node_modules', '@acme', 'mox-thing'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function makePkg(pkgRoot: string, opts: { name: string; entry: string; entryContent: string }) {
  await fs.writeFile(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify(
      {
        name: opts.name,
        version: '1.2.3',
        type: 'module',
        moxxy: { plugin: { entry: opts.entry } },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(pkgRoot, opts.entry), opts.entryContent);
}

describe('discoverPlugins + createPluginLoader (end-to-end)', () => {
  it('finds plugins in cwd/node_modules and loads them via the default loader', async () => {
    const pkgRoot = path.join(cwd, 'node_modules', '@acme', 'mox-thing');
    await makePkg(pkgRoot, {
      name: '@acme/mox-thing',
      entry: 'index.mjs',
      entryContent: `export default Object.freeze({ __moxxy: 'plugin', name: '@acme/mox-thing', version: '1.2.3', tools: [] });\n`,
    });

    const manifests = await discoverPlugins({ cwd, logger: silentLogger });
    const ours = manifests.find((m) => m.packageName === '@acme/mox-thing');
    expect(ours).toBeDefined();
    expect(ours!.entry).toBe('index.mjs');

    const loader = createPluginLoader({ cwd });
    const plugin = await loader.load(ours!);
    expect(plugin.name).toBe('@acme/mox-thing');
    expect(plugin.version).toBe('1.2.3');
  });

  it('stamps the package.json version over a hardcoded definePlugin literal', async () => {
    const pkgRoot = path.join(cwd, 'node_modules', '@acme', 'mox-thing');
    // package.json version is 1.2.3 (makePkg), but the entry hardcodes 0.0.0 —
    // the placeholder plugin authors leave in definePlugin. The loader must
    // report the package version, not the literal.
    await makePkg(pkgRoot, {
      name: '@acme/mox-thing',
      entry: 'index.mjs',
      entryContent: `export default Object.freeze({ __moxxy: 'plugin', name: '@acme/mox-thing', version: '0.0.0', tools: [] });\n`,
    });

    const manifests = await discoverPlugins({ cwd, logger: silentLogger });
    const ours = manifests.find((m) => m.packageName === '@acme/mox-thing');
    const plugin = await createPluginLoader({ cwd }).load(ours!);
    expect(plugin.version).toBe('1.2.3');
  });

  it('ignores packages without a moxxy.plugin manifest', async () => {
    const pkgRoot = path.join(cwd, 'node_modules', 'plain-pkg');
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'plain-pkg', version: '0.0.1' }),
    );

    const manifests = await discoverPlugins({ cwd, logger: silentLogger });
    expect(manifests.find((m) => m.packageName === 'plain-pkg')).toBeUndefined();
  });

  it('rejects entries that do not export a moxxy plugin object', async () => {
    const pkgRoot = path.join(cwd, 'node_modules', '@acme', 'mox-thing');
    await makePkg(pkgRoot, {
      name: '@acme/mox-thing',
      entry: 'index.mjs',
      entryContent: `export default { hello: 'world' };\n`,
    });

    const manifests = await discoverPlugins({ cwd, logger: silentLogger });
    const ours = manifests.find((m) => m.packageName === '@acme/mox-thing')!;
    const loader = createPluginLoader({ cwd });
    await expect(loader.load(ours)).rejects.toThrow(/did not export a valid Plugin/);
  });

  it('walks up parent dirs to find node_modules', async () => {
    const nested = path.join(cwd, 'deeply', 'nested');
    await fs.mkdir(nested, { recursive: true });
    const pkgRoot = path.join(cwd, 'node_modules', '@acme', 'mox-thing');
    await makePkg(pkgRoot, {
      name: '@acme/mox-thing',
      entry: 'index.mjs',
      entryContent: `export default Object.freeze({ __moxxy: 'plugin', name: '@acme/mox-thing', version: '1.0.0' });\n`,
    });

    const manifests = await discoverPlugins({ cwd: nested, logger: silentLogger });
    expect(manifests.find((m) => m.packageName === '@acme/mox-thing')).toBeDefined();
  });
});
