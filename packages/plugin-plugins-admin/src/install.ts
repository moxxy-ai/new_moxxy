import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineTool, z } from '@moxxy/sdk';

/**
 * Where third-party plugins installed at runtime live. The CLI's
 * `setupSessionWithConfig` already scans this directory (and its
 * `node_modules/` subtree) for plugins, so anything `npm install`'ed
 * here becomes discoverable after a `pluginHost.reload()`.
 */
function userPluginsDir(): string {
  return path.join(os.homedir(), '.moxxy', 'plugins');
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
  readonly loops: ReadonlyArray<string>;
  readonly compactors: ReadonlyArray<string>;
  readonly channels: ReadonlyArray<string>;
}

export function buildInstallPluginTool(deps: InstallPluginDeps) {
  return defineTool({
    name: 'install_plugin',
    description:
      'Install a moxxy plugin from the npm registry into the user plugin ' +
      'directory (~/.moxxy/plugins/), then hot-reload the plugin host so the ' +
      'new tools / agents / providers / loops / channels become available in ' +
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
    handler: async ({ packageName, version }) => {
      const dir = userPluginsDir();
      await ensurePackageJson(dir);
      const spec = version ? `${packageName}@${version}` : packageName;
      const before = deps.snapshot();
      const { exitCode, stderr } = await runNpmInstall(dir, spec);
      if (exitCode !== 0) {
        throw new Error(
          `npm install failed (exit ${exitCode}): ${truncate(stderr, 400)}`,
        );
      }
      await deps.reload();
      const after = deps.snapshot();
      return {
        installed: spec,
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
    await fs.writeFile(pkgPath, JSON.stringify(stub, null, 2) + '\n', 'utf8');
  }
}

function runNpmInstall(
  dir: string,
  spec: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['install', '--prefix', dir, '--no-fund', '--no-audit', '--save', spec],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function diffSnapshot(before: PluginSnapshot, after: PluginSnapshot): Record<string, ReadonlyArray<string>> {
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const key of ['tools', 'agents', 'providers', 'loops', 'compactors', 'channels'] as const) {
    const b = new Set(before[key]);
    const added = after[key].filter((n) => !b.has(n));
    if (added.length > 0) out[key] = added;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
