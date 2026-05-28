import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInstallPluginTool, removePluginPackage } from './install.js';

describe('install_plugin tool', () => {
  const noopDeps = {
    reload: async (): Promise<void> => undefined,
    snapshot: () => ({
      tools: [],
      agents: [],
      providers: [],
      modes: [],
      compactors: [],
      channels: [],
    }),
  };

  it('validates package name format', async () => {
    const tool = buildInstallPluginTool(noopDeps);
    const result = tool.inputSchema.safeParse({ packageName: 'NOT VALID NAME' });
    expect(result.success).toBe(false);
  });

  it('accepts a scoped package', () => {
    const tool = buildInstallPluginTool(noopDeps);
    const result = tool.inputSchema.safeParse({ packageName: '@moxxy/agent-researcher' });
    expect(result.success).toBe(true);
  });

  it('accepts an optional version', () => {
    const tool = buildInstallPluginTool(noopDeps);
    const result = tool.inputSchema.safeParse({
      packageName: '@moxxy/agent-researcher',
      version: '1.2.3',
    });
    expect(result.success).toBe(true);
  });
});

describe('removePluginPackage', () => {
  it('uninstalls a package from the user plugins directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'moxxy-plugin-remove-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'moxxy-user-plugins',
          private: true,
          dependencies: {
            'left-pad': '1.3.0',
          },
        },
        null,
        2,
      ),
    );

    try {
      const result = await removePluginPackage({
        packageName: 'left-pad',
        dir,
      });

      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };

      expect(result.removed).toBe('left-pad');
      expect(pkg.dependencies?.['left-pad']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
