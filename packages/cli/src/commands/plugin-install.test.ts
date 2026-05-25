import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPluginInstallCommand } from './plugin-install.js';

let tmpHome: string;
let fixtureRoot: string;
let origHome: string | undefined;
let writeOut: string[];
let writeErr: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-pinstall-home-'));
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-pinstall-fixture-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  writeOut = [];
  writeErr = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writeOut.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writeErr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function makeArgv(positional: string[], flags: Record<string, string | boolean> = {}) {
  return {
    command: 'plugins',
    positional,
    flags,
  } as never;
}

async function writeUiFixture(): Promise<string> {
  const pkgDir = path.join(fixtureRoot, 'virtual-office-fixture');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: '@moxxy/virtual-office-fixture',
        version: '1.0.0',
        type: 'module',
        moxxy: {
          plugin: {
            entry: './serve.js',
            kind: 'ui',
            port: 17901,
          },
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(pkgDir, 'serve.js'), 'console.log("fixture");\n');
  return pkgDir;
}

describe('plugins install', () => {
  it('installs a local ui plugin package into ~/.moxxy/plugins/node_modules', async () => {
    const pkgDir = await writeUiFixture();

    const code = await runPluginInstallCommand(makeArgv(['install', pkgDir]));

    expect(code).toBe(0);
    const installed = path.join(
      tmpHome,
      '.moxxy',
      'plugins',
      'node_modules',
      '@moxxy',
      'virtual-office-fixture',
      'package.json',
    );
    const pkg = JSON.parse(await fs.readFile(installed, 'utf8'));
    expect(pkg.moxxy.plugin).toMatchObject({ kind: 'ui', port: 17901 });
    expect(writeOut.join('')).toContain('installed');
    expect(writeErr.join('')).toBe('');
  });
});
