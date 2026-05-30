/**
 * Drives system-level installs that the onboarding wizard offers:
 *
 *   - Probe Node (presence + version)
 *   - `npm install -g @moxxy/cli` with progress streamed to the
 *     renderer so the user sees something happening
 *
 * The renderer sees install progress via the `onboarding.install.progress`
 * IPC event; the final result also comes back from the invoke().
 */

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { type BrowserWindow } from 'electron';
import { augmentedPaths, nodeLauncher, resolveMoxxyCli, spawnPath } from './cli-resolver';
import { assertSafeProviderName } from './security';

export interface NodeProbe {
  installed: boolean;
  version: string | null;
  bin: string | null;
}

/**
 * Spawn `node --version` and return the trimmed string. Fast (250ms
 * budget); a hung child can't block the wizard.
 */
export async function probeNode(): Promise<NodeProbe> {
  const bin = findNodeBin();
  if (!bin) return { installed: false, version: null, bin: null };
  return new Promise<NodeProbe>((resolve) => {
    const proc = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    const t = setTimeout(() => {
      proc.kill();
      resolve({ installed: false, version: null, bin });
    }, 2_000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ installed: true, version: out.trim(), bin });
      else resolve({ installed: false, version: null, bin });
    });
    proc.on('error', () => {
      clearTimeout(t);
      resolve({ installed: false, version: null, bin });
    });
  });
}

function findNodeBin(): string | null {
  const PATH = process.env.PATH ?? '';
  const dirs = PATH.split(':').concat(augmentedPaths()).filter(Boolean);
  for (const dir of dirs) {
    const candidate = `${dir}/node`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { statSync } = require('node:fs');
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Run `npm install -g @moxxy/cli`. Streams every stdout/stderr line
 * to the renderer as `onboarding.install.progress` events. Returns the
 * exit code.
 *
 * Rejects only if npm isn't found on PATH; install failures (non-zero
 * exit) resolve normally with the code so the UI can decide what to
 * say.
 */
export async function installMoxxyCli(window: BrowserWindow): Promise<number> {
  const npm = findExe('npm');
  if (!npm) throw new Error('npm not found on PATH');

  emit(window, '$ npm install -g @moxxy/cli');

  return new Promise<number>((resolve, reject) => {
    const proc = spawn(npm, ['install', '-g', '@moxxy/cli'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm is itself a `#!/usr/bin/env node` shebang; a GUI-launched app
      // lacks the shell PATH, so put node's dir (= npm's dir) on PATH.
      env: { ...process.env, PATH: spawnPath([dirname(npm)]) },
    });
    proc.stdout?.on('data', (b: Buffer) => stream(window, b.toString()));
    proc.stderr?.on('data', (b: Buffer) => stream(window, b.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve(code ?? -1));
  });
}

/**
 * Spawn `moxxy login <provider>`. The CLI runs the provider's OAuth
 * flow — opens the system browser to the provider's auth page and
 * listens for the loopback callback — then stores the resulting
 * tokens in the vault.
 *
 * stdout + stderr stream back to the renderer via the same channel
 * the npm install uses (`onboarding.install.progress`). Resolves
 * with the exit code; the wizard treats 0 as "logged in".
 */
export async function runProviderLogin(
  provider: string,
  window: BrowserWindow,
): Promise<number> {
  assertSafeProviderName(provider);
  const cli = resolveMoxxyCli({ extraPaths: augmentedPaths() });
  if (!cli) throw new Error('moxxy CLI not found — run the install step first');

  emit(window, `$ moxxy login ${provider} --browser`);

  // GUI launches lack the shell PATH, so moxxy's `#!/usr/bin/env node`
  // shebang can't find node → `moxxy login` died with
  // "env: node: No such file or directory". Put node's dir (= the resolved
  // CLI's dir) + the known install locations on PATH for the OAuth child.
  const cliDir = cli.kind === 'direct' ? dirname(cli.bin) : dirname(cli.entry);
  const env = { ...process.env, PATH: spawnPath([cliDir]) };

  // `--browser` forces the loopback flow (which opens the system browser
  // automatically + catches the localhost callback) instead of the headless
  // device-code flow `moxxy login` would otherwise pick because we spawn it
  // with piped stdio (no TTY). The desktop is a GUI — no code copying.
  const loginArgs = ['login', provider, '--browser'];

  return new Promise<number>((resolve, reject) => {
    let proc;
    if (cli.kind === 'direct') {
      proc = spawn(cli.bin, loginArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } else {
      // No system `node` on a GUI launch — run the bundled CLI with
      // Electron's own Node (ELECTRON_RUN_AS_NODE), merged onto the PATH env.
      const { command, env: nodeEnv } = nodeLauncher();
      proc = spawn(command, [cli.entry, ...loginArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...nodeEnv },
      });
    }
    proc.stdout?.on('data', (b: Buffer) => stream(window, b.toString()));
    proc.stderr?.on('data', (b: Buffer) => stream(window, b.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve(code ?? -1));
  });
}

function findExe(name: string): string | null {
  const PATH = process.env.PATH ?? '';
  const dirs = PATH.split(':').concat(augmentedPaths()).filter(Boolean);
  for (const dir of dirs) {
    const candidate = `${dir}/${name}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { statSync } = require('node:fs');
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function stream(window: BrowserWindow, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line) emit(window, line);
  }
}

function emit(window: BrowserWindow, line: string): void {
  if (window.isDestroyed()) return;
  window.webContents.send('onboarding.install.progress', line);
}
