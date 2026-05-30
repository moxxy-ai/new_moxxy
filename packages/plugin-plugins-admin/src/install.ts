import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defineTool, moxxyPath, writeFileAtomic, z } from '@moxxy/sdk';

/**
 * Where third-party plugins installed at runtime live. The CLI's
 * `setupSessionWithConfig` already scans this directory (and its
 * `node_modules/` subtree) for plugins, so anything `npm install`'ed
 * here becomes discoverable after a `pluginHost.reload()`.
 */
export function userPluginsDir(): string {
  return moxxyPath('plugins');
}

const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION_RE = /^[0-9a-z.~^*<=>-]+$/i;

export interface InstallPluginDeps {
  /**
   * How the tool triggers a hot-reload after a successful install.
   * Bound at construction so the handler doesn't need to import core.
   */
  readonly reload: () => Promise<void>;
  /**
   * Snapshot of the plugin host before/after reload so we can report
   * which contributions (tools, agents, etc.) the freshly installed
   * package brought in. Returns names per kind.
   */
  readonly snapshot: () => PluginSnapshot;
}

export interface PluginSnapshot {
  readonly tools: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<string>;
  readonly modes: ReadonlyArray<string>;
  readonly compactors: ReadonlyArray<string>;
  readonly channels: ReadonlyArray<string>;
}

export interface InstallPluginPackageOptions {
  /** Full npm install spec: a package name, `name@version`, git, or path. */
  readonly packageName: string;
  /** Optional version/dist-tag used by CLI helpers that split name and version. */
  readonly version?: string;
  /** Override install directory, mostly for tests. */
  readonly dir?: string;
  /** Optional abort signal; aborting kills the npm child process. */
  readonly signal?: AbortSignal;
}

export interface InstallPluginPackageResult {
  /** The spec that was installed. */
  readonly installed: string;
  /** The plugins directory the package was installed into. */
  readonly dir: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RemovePluginPackageOptions {
  /** npm package name to uninstall from the plugins directory. */
  readonly packageName: string;
  /** Override install directory, mostly for tests. */
  readonly dir?: string;
  /** Optional abort signal; aborting kills the npm child process. */
  readonly signal?: AbortSignal;
}

export interface RemovePluginPackageResult {
  /** The package name that was removed. */
  readonly removed: string;
  /** The plugins directory the package was removed from. */
  readonly dir: string;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Install a plugin package into `~/.moxxy/plugins/` via `npm install`.
 * Imperative counterpart to the `install_plugin` tool, used by the
 * marketplace CLI. Does NOT hot-reload — callers that need new tools to
 * appear in a live session must reload the plugin host themselves.
 */
export async function installPluginPackage(
  opts: InstallPluginPackageOptions,
): Promise<InstallPluginPackageResult> {
  const dir = opts.dir ?? userPluginsDir();
  await ensurePackageJson(dir);
  const spec = opts.version ? `${opts.packageName}@${opts.version}` : opts.packageName;
  const { exitCode, stdout, stderr } = await runNpm(
    ['install', '--prefix', dir, '--no-fund', '--no-audit', '--save', spec],
    opts.signal,
  );
  if (exitCode !== 0) {
    throw new Error(`npm install failed (exit ${exitCode}): ${truncate(stderr, 400)}`);
  }
  return { installed: spec, dir, stdout, stderr };
}

/**
 * Uninstall a plugin package from `~/.moxxy/plugins/` via `npm uninstall`.
 */
export async function removePluginPackage(
  opts: RemovePluginPackageOptions,
): Promise<RemovePluginPackageResult> {
  const dir = opts.dir ?? userPluginsDir();
  await ensurePackageJson(dir);
  const { exitCode, stdout, stderr } = await runNpm(
    ['uninstall', '--prefix', dir, '--no-fund', '--no-audit', '--save', opts.packageName],
    opts.signal,
  );
  if (exitCode !== 0) {
    throw new Error(`npm uninstall failed (exit ${exitCode}): ${truncate(stderr, 400)}`);
  }
  return { removed: opts.packageName, dir, stdout, stderr };
}

export function buildInstallPluginTool(deps: InstallPluginDeps) {
  return defineTool({
    name: 'install_plugin',
    description:
      'Install a moxxy plugin from the npm registry into the user plugin ' +
      'directory (~/.moxxy/plugins/), then hot-reload the plugin host so the ' +
      'new tools / agents / providers / modes / channels become available in ' +
      'the current session. Requires `npm` on PATH. Returns the diff of what ' +
      "got registered. Use this when the user asks to install a moxxy plugin " +
      'they\'ve named (e.g. "install @moxxy/agent-researcher").',
    inputSchema: z.object({
      packageName: z
        .string()
        .min(1)
        .refine((s) => NPM_NAME_RE.test(s), {
          message: 'must be a valid npm package name (e.g. @moxxy/agent-researcher)',
        })
        .describe('npm package name. Scoped (@org/pkg) or bare.'),
      version: z
        .string()
        .optional()
        .refine((v) => v === undefined || VERSION_RE.test(v), {
          message: 'must be a valid semver range or dist-tag',
        })
        .describe('Optional version / dist-tag. Defaults to "latest".'),
    }),
    permission: { action: 'prompt' },
    // install_plugin shells out to `npm install`, which spawns a child
    // process, reads/writes the user plugin dir, and hits the network to
    // fetch packages. These caps are *honest*: the in-process isolator
    // can't constrain what npm does, but a future subprocess/sandbox
    // isolator can use them to confine the install.
    isolation: {
      capabilities: {
        subprocess: true,
        commands: ['npm'],
        net: { mode: 'any' },
        fs: { read: ['$cwd/**'], write: [`${userPluginsDir()}/**`] },
      },
    },
    handler: async ({ packageName, version }, ctx) => {
      const before = deps.snapshot();
      const { installed } = await installPluginPackage({ packageName, version, signal: ctx.signal });
      await deps.reload();
      const after = deps.snapshot();
      return {
        installed,
        registered: diffSnapshot(before, after),
      };
    },
  });
}

/**
 * Make sure `~/.moxxy/plugins/package.json` exists so `npm install`
 * runs cleanly. Created with `private: true` so a stray `npm publish`
 * can't ship our junk dir, and `type: module` so ESM plugins load via
 * Node's loader without surprises.
 */
async function ensurePackageJson(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const pkgPath = path.join(dir, 'package.json');
  try {
    await fs.access(pkgPath);
  } catch {
    const stub = {
      name: 'moxxy-user-plugins',
      version: '0.0.0',
      private: true,
      type: 'module',
      description: 'Auto-generated workspace for moxxy plugins installed at runtime.',
    };
    await writeFileAtomic(pkgPath, JSON.stringify(stub, null, 2) + '\n');
  }
}

function runNpm(
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('npm aborted before start'));
      return;
    }
    const child = spawn('npm', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function diffSnapshot(before: PluginSnapshot, after: PluginSnapshot): Record<string, ReadonlyArray<string>> {
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const key of ['tools', 'agents', 'providers', 'modes', 'compactors', 'channels'] as const) {
    const b = new Set(before[key]);
    const added = after[key].filter((n) => !b.has(n));
    if (added.length > 0) out[key] = added;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
