import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildInstallSpec,
  buildMarketplaceOptions,
  DEFAULT_MARKETPLACE_CATALOG,
  loadDisabledPackageNames,
  runMarketplaceCommand,
  setPluginEnabled,
} from './index.js';

function argv(positional: string[], flags: Record<string, unknown> = {}) {
  return { command: 'marketplace', positional, flags };
}

describe('marketplace catalog', () => {
  it('contains virtual-office installed from GitHub main', () => {
    expect(DEFAULT_MARKETPLACE_CATALOG).toContainEqual(
      expect.objectContaining({
        id: 'virtual-office',
        packageName: '@moxxy/virtual-office-plugin',
        installSpec: 'github:moxxy-ai/virtual-office-plugin#main',
        startCommand: 'moxxy marketplace open virtual-office --tui',
        openFlags: { tui: true },
        defaultPort: 17901,
      }),
    );
  });

  it('applies --ref to GitHub install specs', () => {
    expect(buildInstallSpec({ target: 'virtual-office', ref: 'dev' })).toBe(
      'github:moxxy-ai/virtual-office-plugin#dev',
    );
  });

  it('builds picker statuses for not installed, installed, and disabled', () => {
    const [option] = buildMarketplaceOptions({
      catalog: DEFAULT_MARKETPLACE_CATALOG,
      installedPackageNames: new Set(['@moxxy/virtual-office-plugin']),
      disabledPackageNames: new Set(['@moxxy/virtual-office-plugin']),
    });

    expect(option?.hint).toBe('disabled');
  });
});

describe('runMarketplaceCommand', () => {
  it('interactive picker lets the user disable an installed plugin', async () => {
    const calls: string[] = [];
    const code = await runMarketplaceCommand(argv([]), {
      isInteractive: () => true,
      loadInstalledPackageNames: async () => new Set(['@moxxy/virtual-office-plugin']),
      loadDisabledPackageNames: async () => new Set(),
      selectPlugin: async () => 'virtual-office',
      selectAction: async () => 'disable',
      setPluginEnabled: async (packageName, enabled) => {
        calls.push(`${packageName}:${enabled}`);
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    } as never);

    expect(code).toBe(0);
    expect(calls).toEqual(['@moxxy/virtual-office-plugin:false']);
  });

  it('interactive picker lets the user enable a disabled plugin', async () => {
    const calls: string[] = [];
    const code = await runMarketplaceCommand(argv([]), {
      isInteractive: () => true,
      loadInstalledPackageNames: async () => new Set(['@moxxy/virtual-office-plugin']),
      loadDisabledPackageNames: async () => new Set(['@moxxy/virtual-office-plugin']),
      selectPlugin: async () => 'virtual-office',
      selectAction: async () => 'enable',
      setPluginEnabled: async (packageName, enabled) => {
        calls.push(`${packageName}:${enabled}`);
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    } as never);

    expect(code).toBe(0);
    expect(calls).toEqual(['@moxxy/virtual-office-plugin:true']);
  });

  it('interactive picker can return without installing a selected plugin', async () => {
    const calls: string[] = [];
    const code = await runMarketplaceCommand(argv([]), {
      isInteractive: () => true,
      loadInstalledPackageNames: async () => new Set(),
      loadDisabledPackageNames: async () => new Set(),
      selectPlugin: async () => 'virtual-office',
      selectAction: async () => 'back',
      installPluginPackage: async (opts) => {
        calls.push(opts.packageName);
        return { installed: opts.packageName, dir: '/tmp/plugins', stdout: '', stderr: '' };
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    } as never);

    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it('interactive picker shows installation progress while installing a plugin', async () => {
    const calls: string[] = [];
    const code = await runMarketplaceCommand(argv([]), {
      isInteractive: () => true,
      loadInstalledPackageNames: async () => new Set(),
      loadDisabledPackageNames: async () => new Set(),
      selectPlugin: async () => 'virtual-office',
      selectAction: async () => 'install',
      createSpinner: () => ({
        start: (message) => calls.push(`start:${message}`),
        stop: (message) => calls.push(`stop:${message}`),
        error: (message) => calls.push(`error:${message}`),
      }),
      installPluginPackage: async (opts) => {
        calls.push(`install:${opts.packageName}`);
        return { installed: opts.packageName, dir: '/tmp/plugins', stdout: '', stderr: '' };
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    } as never);

    expect(code).toBe(0);
    expect(calls).toEqual([
      'start:Installing Virtual Office...',
      'install:github:moxxy-ai/virtual-office-plugin#main',
      'stop:Installed Virtual Office',
    ]);
  });

  it('interactive picker marks installation progress as failed when install throws', async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const code = await runMarketplaceCommand(argv([]), {
      isInteractive: () => true,
      loadInstalledPackageNames: async () => new Set(),
      loadDisabledPackageNames: async () => new Set(),
      selectPlugin: async () => 'virtual-office',
      selectAction: async () => 'install',
      createSpinner: () => ({
        start: (message) => calls.push(`start:${message}`),
        stop: (message) => calls.push(`stop:${message}`),
        error: (message) => calls.push(`error:${message}`),
      }),
      installPluginPackage: async (opts) => {
        calls.push(`install:${opts.packageName}`);
        throw new Error('network died');
      },
      writeOut: () => undefined,
      writeErr: (text) => errors.push(text),
    } as never);

    expect(code).toBe(1);
    expect(calls).toEqual([
      'start:Installing Virtual Office...',
      'install:github:moxxy-ai/virtual-office-plugin#main',
      'error:Install failed',
    ]);
    expect(errors.join('')).toContain('network died');
  });

  it('installs virtual-office from the catalog spec', async () => {
    const calls: unknown[] = [];
    const code = await runMarketplaceCommand(argv(['add', 'virtual-office']), {
      installPluginPackage: async (opts) => {
        calls.push(opts);
        return { installed: opts.packageName, dir: '/tmp/plugins', stdout: '', stderr: '' };
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ packageName: 'github:moxxy-ai/virtual-office-plugin#main' }]);
  });

  it('removes virtual-office and clears marketplace state', async () => {
    const calls: string[] = [];
    const code = await runMarketplaceCommand(argv(['remove', 'virtual-office']), {
      removePluginPackage: async (opts) => {
        calls.push(`remove:${opts.packageName}`);
        return { removed: opts.packageName, dir: '/tmp/plugins', stdout: '', stderr: '' };
      },
      clearPluginState: async (packageName) => {
        calls.push(`clear:${packageName}`);
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      'remove:@moxxy/virtual-office-plugin',
      'clear:@moxxy/virtual-office-plugin',
    ]);
  });

  it('blocks opening disabled virtual-office', async () => {
    const errors: string[] = [];
    const code = await runMarketplaceCommand(argv(['open', 'virtual-office']), {
      isPluginDisabled: async () => true,
      startUiPlugin: async () => 0,
      writeErr: (text) => errors.push(text),
      writeOut: () => undefined,
    });

    expect(code).toBe(1);
    expect(errors.join('')).toContain('moxxy marketplace enable virtual-office');
  });

  it('opens virtual-office with catalog default TUI mode', async () => {
    const opened: unknown[] = [];
    const code = await runMarketplaceCommand(argv(['open', 'virtual-office']), {
      isPluginDisabled: async () => false,
      startUiPlugin: async (next) => {
        opened.push(next);
        return 0;
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(code).toBe(0);
    expect(opened).toEqual([
      expect.objectContaining({
        command: 'marketplace',
        positional: ['open', '@moxxy/virtual-office-plugin'],
        flags: expect.objectContaining({ tui: true }),
      }),
    ]);
  });

  it('preserves explicit flags and passthrough when applying catalog open defaults', async () => {
    const opened: unknown[] = [];
    const code = await runMarketplaceCommand(
      {
        command: 'marketplace',
        positional: ['open', 'virtual-office'],
        flags: { port: '18000', open: true },
        passthrough: ['--theme', 'dark'],
      },
      {
        isPluginDisabled: async () => false,
        startUiPlugin: async (next) => {
          opened.push(next);
          return 0;
        },
        writeOut: () => undefined,
        writeErr: () => undefined,
      },
    );

    expect(code).toBe(0);
    expect(opened).toEqual([
      expect.objectContaining({
        flags: {
          tui: true,
          port: '18000',
          open: true,
        },
        passthrough: ['--theme', 'dark'],
      }),
    ]);
  });
});

describe('marketplace user config', () => {
  it('writes plugin enablement state to config.yaml', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'moxxy-marketplace-config-'));
    const configPath = path.join(dir, 'config.yaml');

    try {
      await setPluginEnabled('@moxxy/virtual-office-plugin', false, { configPath });

      expect(await loadDisabledPackageNames({ configPath })).toEqual(
        new Set(['@moxxy/virtual-office-plugin']),
      );
      expect(await readFile(configPath, 'utf8')).toContain('@moxxy/virtual-office-plugin');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
