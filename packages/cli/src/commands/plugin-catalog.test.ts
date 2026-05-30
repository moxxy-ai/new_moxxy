import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLUGIN_CATALOG,
  buildCatalogOptions,
  runPluginCatalogCommand,
} from './plugin-catalog.js';

function makeArgv() {
  return {
    command: 'plugins',
    positional: [],
    flags: {},
  } as never;
}

describe('plugin catalog', () => {
  it('ships Virtual Office as an installable GitHub catalog entry', () => {
    expect(DEFAULT_PLUGIN_CATALOG).toContainEqual(
      expect.objectContaining({
        id: 'virtual-office',
        packageName: '@moxxy/virtual-office-plugin',
        installSpec: 'github:moxxy-ai/virtual-office-plugin#main',
        defaultPort: 17901,
      }),
    );
  });

  it('marks Virtual Office as installable when it is not present locally', () => {
    const options = buildCatalogOptions(DEFAULT_PLUGIN_CATALOG, new Set());

    expect(options[0]).toMatchObject({
      value: 'virtual-office',
      label: 'Virtual Office',
      hint: 'install from github:moxxy-ai/virtual-office-plugin#main',
    });
  });

  it('installs Virtual Office from GitHub when selected', async () => {
    const installed: string[] = [];
    const output: string[] = [];

    const code = await runPluginCatalogCommand(makeArgv(), {
      loadInstalledPackageNames: async () => new Set(),
      selectPlugin: async () => 'virtual-office',
      installPluginPackage: async ({ packageName }) => {
        installed.push(packageName);
        return { installed: packageName, dir: '/tmp/moxxy/plugins', stdout: '', stderr: '' };
      },
      writeOut: (text) => output.push(text),
    });

    expect(code).toBe(0);
    expect(installed).toEqual(['github:moxxy-ai/virtual-office-plugin#main']);
    expect(output.join('')).toContain('@moxxy/virtual-office-plugin');
    expect(output.join('')).toContain('moxxy marketplace open virtual-office --tui');
  });

  it('does not reinstall an already-installed catalog plugin', async () => {
    const installed: string[] = [];
    const output: string[] = [];

    const code = await runPluginCatalogCommand(makeArgv(), {
      loadInstalledPackageNames: async () => new Set(['@moxxy/virtual-office-plugin']),
      selectPlugin: async () => 'virtual-office',
      installPluginPackage: async ({ packageName }) => {
        installed.push(packageName);
        return { installed: packageName, dir: '/tmp/moxxy/plugins', stdout: '', stderr: '' };
      },
      writeOut: (text) => output.push(text),
    });

    expect(code).toBe(0);
    expect(installed).toEqual([]);
    expect(output.join('')).toContain('already installed');
    expect(output.join('')).toContain('moxxy marketplace open virtual-office --tui');
  });
});
