import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin } from '@moxxy/sdk';
import type { MoxxyConfig } from '@moxxy/config';
import { registerPlugins } from './register-plugins.js';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function stageFakePackage(
  pkgName: string,
  moxxy: object,
): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-register-plugins-'));
  tempDirs.push(cwd);
  const pkgDir = path.join(cwd, 'node_modules', ...pkgName.split('/'));
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkgName, version: '0.0.0', moxxy }),
  );
  return cwd;
}

describe('registerPlugins', () => {
  it('resolves builtin requirements from package.json and reports unmet ones as skips', async () => {
    const cwd = await stageFakePackage('needs-base', {
      requirements: [
        { kind: 'plugin', name: 'base-plugin', hint: 'Enable base-plugin.' },
      ],
    });
    const session = new Session({ cwd, logger: silentLogger });
    const result = await registerPlugins(
      session,
      {} as MoxxyConfig,
      [{ name: 'needs-base', plugin: definePlugin({ name: 'needs-base' }) }],
      cwd,
      silentLogger,
      { discover: false },
    );

    expect(result.registered.size).toBe(0);
    expect(result.skipped).toMatchObject([
      {
        pluginName: 'needs-base',
        source: 'static',
        reason: 'unmet_requirements',
        message: 'Required plugin is not registered: base-plugin',
        hints: ['Enable base-plugin.'],
      },
    ]);
  });

  it('orders builtins by their declared plugin requirements', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-register-plugins-order-'));
    tempDirs.push(cwd);
    const stage = async (name: string, moxxy: object): Promise<void> => {
      const pkgDir = path.join(cwd, 'node_modules', ...name.split('/'));
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', moxxy }),
      );
    };
    await stage('base', {});
    await stage('dependent', {
      requirements: [{ kind: 'plugin', name: 'base', state: 'registered' }],
    });

    const session = new Session({ cwd, logger: silentLogger });
    // Pass dependent first so we exercise the reorder.
    const result = await registerPlugins(
      session,
      {} as MoxxyConfig,
      [
        { name: 'dependent', plugin: definePlugin({ name: 'dependent' }) },
        { name: 'base', plugin: definePlugin({ name: 'base' }) },
      ],
      cwd,
      silentLogger,
      { discover: false },
    );

    expect([...result.registered]).toEqual(['base', 'dependent']);
  });

  it('discovers pure ui plugins without importing their entry as a runtime plugin', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-register-ui-plugin-'));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'moxxy-register-ui-home-'));
    tempDirs.push(fakeHome);
    const pkgDir = path.join(cwd, 'node_modules', '@moxxy', 'virtual-office-plugin');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@moxxy/virtual-office-plugin',
        version: '0.0.7',
        type: 'module',
        moxxy: {
          plugin: {
            entry: './serve.js',
            kind: 'ui',
            port: 17901,
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, 'serve.js'),
      "throw new Error('serve.js must not be imported by the runtime plugin loader');\n",
    );
    const warnings: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (msg: string): void => {
        warnings.push(msg);
      },
    };
    const session = new Session({ cwd, logger });

    const prevHome = process.env.HOME;
    const prevUserprofile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const result = await registerPlugins(
        session,
        {} as MoxxyConfig,
        [],
        cwd,
        logger,
      );

      expect([...result.registered]).toEqual([]);
      expect(session.pluginHost.list()).toEqual([]);
      expect(warnings.join('\n')).not.toContain('failed to load plugin');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserprofile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserprofile;
    }
  });
});
