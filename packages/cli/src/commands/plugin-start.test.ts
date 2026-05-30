import { promises as fs } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runPluginStartCommand,
  startSessionSelectionServer,
  isStartableUiPluginManifest,
  startUiPlugin,
  startUiPluginHost,
  startUiPluginHostWithSessionSelection,
  startUiPluginProcess,
} from './plugin-start.js';
import type { PermissionResolver } from '@moxxy/sdk';
import type { SessionMeta } from '@moxxy/core';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mox-pstart-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeFixture(): Promise<{ packagePath: string; envPath: string }> {
  const packagePath = path.join(tmp, 'node_modules', '@moxxy', 'virtual-office-fixture');
  const envPath = path.join(tmp, 'env.json');
  await fs.mkdir(packagePath, { recursive: true });
  await fs.writeFile(
    path.join(packagePath, 'package.json'),
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
  await fs.writeFile(
    path.join(packagePath, 'serve.js'),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.ENV_PATH, JSON.stringify({",
      "  PORT: process.env.PORT,",
      "  HOST: process.env.HOST,",
      "  MOXXY_PLUGIN_PORT: process.env.MOXXY_PLUGIN_PORT,",
      "  MOXXY_PLUGIN_HOST: process.env.MOXXY_PLUGIN_HOST,",
      "  MOXXY_API_URL: process.env.MOXXY_API_URL,",
      "  MOXXY_TOKEN: process.env.MOXXY_TOKEN,",
      "  MOXXY_PLUGIN_NAME: process.env.MOXXY_PLUGIN_NAME,",
      "  argv: process.argv.slice(2),",
      "}));",
    ].join('\n'),
  );
  return { packagePath, envPath };
}

async function listenOnFreePort(host?: string): Promise<{ server: NetServer; port: number }> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function closeServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe('startUiPlugin', () => {
  it('treats hybrid ui cli plugin manifests as startable UI plugins', () => {
    expect(isStartableUiPluginManifest({ kind: 'ui' })).toBe(true);
    expect(isStartableUiPluginManifest({ kind: ['ui', 'cli'] })).toBe(true);
    expect(isStartableUiPluginManifest({ kind: 'cli' })).toBe(false);
  });

  it('starts a ui plugin entry with the selected ui and bridge ports in env', async () => {
    const { packagePath, envPath } = await writeFixture();

    const result = await startUiPlugin({
      manifest: {
        packageName: '@moxxy/virtual-office-fixture',
        packageVersion: '1.0.0',
        packagePath,
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
      },
      uiPort: 18000,
      apiPort: 3737,
      token: 'test-token',
      extraEnv: { ENV_PATH: envPath },
    });

    expect(result.exitCode).toBe(0);
    const env = JSON.parse(await fs.readFile(envPath, 'utf8'));
    expect(env).toMatchObject({
      PORT: '18000',
      HOST: '127.0.0.1',
      MOXXY_PLUGIN_PORT: '18000',
      MOXXY_PLUGIN_HOST: '127.0.0.1',
      MOXXY_API_URL: 'http://127.0.0.1:3737',
      MOXXY_TOKEN: 'test-token',
      MOXXY_PLUGIN_NAME: '@moxxy/virtual-office-fixture',
      argv: [],
    });
  });

  it('forwards extraArgs and manifest host into the spawned UI plugin process', async () => {
    const { packagePath, envPath } = await writeFixture();

    const result = await startUiPlugin({
      manifest: {
        packageName: '@moxxy/virtual-office-fixture',
        packageVersion: '1.0.0',
        packagePath,
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
        host: '0.0.0.0',
      },
      uiPort: 18000,
      apiPort: 3737,
      token: 'test-token',
      extraEnv: { ENV_PATH: envPath },
      extraArgs: ['--theme', 'dark', '--debug'],
    });

    expect(result.exitCode).toBe(0);
    const env = JSON.parse(await fs.readFile(envPath, 'utf8'));
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.MOXXY_PLUGIN_HOST).toBe('0.0.0.0');
    expect(env.argv).toEqual(['--theme', 'dark', '--debug']);
  });

  it('can stop a long-running ui plugin process', async () => {
    const { packagePath } = await writeFixture();
    await fs.writeFile(
      path.join(packagePath, 'serve.js'),
      [
        "setInterval(() => {}, 1000);",
      ].join('\n'),
    );

    const handle = startUiPluginProcess({
      manifest: {
        packageName: '@moxxy/virtual-office-fixture',
        packageVersion: '1.0.0',
        packagePath,
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
      },
      uiPort: 18000,
      apiPort: 3737,
      token: 'test-token',
      stdio: 'ignore',
    });

    await handle.stop('SIGTERM');
    await expect(handle.running).resolves.toMatchObject({ exitCode: 0 });
  });

  it('refuses to open a UI plugin when the UI port is already in use', async () => {
    const { packagePath } = await writeFixture();
    await fs.writeFile(
      path.join(packagePath, 'serve.js'),
      [
        "import { createServer } from 'node:http';",
        "createServer((_req, res) => res.end('ok')).listen(Number(process.env.PORT));",
      ].join('\n'),
    );
    const uiPort = await listenOnFreePort();
    const apiPort = await listenOnFreePort('127.0.0.1');
    const outputs: string[] = [];
    const errors: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        outputs.push(String(chunk));
        return true;
      });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        errors.push(String(chunk));
        return true;
      });

    try {
      await closeServer(apiPort.server);
      const code = await runPluginStartCommand({
        command: 'ui',
        positional: ['open', packagePath],
        flags: {
          port: String(uiPort.port),
          'api-port': String(apiPort.port),
          'no-open': true,
        },
        passthrough: [],
      });

      expect(code).toBe(1);
      expect(outputs.join('')).not.toContain('session picker');
      expect(errors.join('')).toContain(`UI plugin port ${uiPort.port} is already in use`);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await closeServer(uiPort.server);
    }
  });

  it('starts bridge and tui against the same session when tui mode is enabled', async () => {
    const { packagePath } = await writeFixture();
    const bridgeResolver = { resolve: vi.fn() } as unknown as PermissionResolver;
    const tuiResolver = { resolve: vi.fn() } as unknown as PermissionResolver;
    const session = {
      setPermissionResolver: vi.fn(),
      close: vi.fn(async () => undefined),
      logger: {},
    };
    const bridgeHandle = {
      running: new Promise<void>(() => undefined),
      stop: vi.fn(async () => undefined),
    };
    const tuiHandle = {
      running: new Promise<void>(() => undefined),
      stop: vi.fn(async () => undefined),
    };
    const bridge = {
      permissionResolver: bridgeResolver,
      start: vi.fn(async (opts: { session: unknown }) => {
        expect(opts.session).toBe(session);
        return bridgeHandle;
      }),
    };
    const tui = {
      permissionResolver: tuiResolver,
      start: vi.fn(async (opts: { session: unknown }) => {
        expect(opts.session).toBe(session);
        return tuiHandle;
      }),
    };
    const uiProcess = {
      running: Promise.resolve({ exitCode: 0 }),
      stop: vi.fn(async () => undefined),
    };

    const result = await startUiPluginHost({
      session: session as never,
      bridge: bridge as never,
      manifest: {
        packageName: '@moxxy/virtual-office-fixture',
        packageVersion: '1.0.0',
        packagePath,
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
      },
      uiPort: 18000,
      apiPort: 3737,
      token: 'test-token',
      withTui: true,
      createTuiChannel: () => tui as never,
      startUiProcess: vi.fn(() => uiProcess),
      stdout: { write: vi.fn() } as never,
    });

    expect(result.exitCode).toBe(0);
    expect(bridge.start).toHaveBeenCalledOnce();
    expect(tui.start).toHaveBeenCalledOnce();
    expect(session.setPermissionResolver).toHaveBeenCalledWith(bridgeResolver);
    expect(session.setPermissionResolver).toHaveBeenCalledWith(tuiResolver);
    expect(bridgeHandle.stop).toHaveBeenCalledOnce();
    expect(tuiHandle.stop).toHaveBeenCalledOnce();
  });

  it('stops the UI plugin and bridge when the TUI exits first', async () => {
    const { packagePath } = await writeFixture();
    let finishTui!: () => void;
    const tuiRunning = new Promise<void>((resolve) => {
      finishTui = resolve;
    });
    const session = {
      setPermissionResolver: vi.fn(),
      close: vi.fn(async () => undefined),
      logger: {},
    };
    const bridge = {
      permissionResolver: { resolve: vi.fn() } as unknown as PermissionResolver,
      start: vi.fn(async () => ({
        running: new Promise<void>(() => undefined),
        stop: vi.fn(async () => undefined),
      })),
    };
    const tuiHandle = {
      running: tuiRunning,
      stop: vi.fn(async () => undefined),
    };
    const tui = {
      permissionResolver: { resolve: vi.fn() } as unknown as PermissionResolver,
      start: vi.fn(async () => tuiHandle),
    };
    const uiProcess = {
      running: new Promise<{ exitCode: number }>(() => undefined),
      stop: vi.fn(async () => undefined),
    };

    const running = startUiPluginHost({
      session: session as never,
      bridge: bridge as never,
      manifest: {
        packageName: '@moxxy/virtual-office-fixture',
        packageVersion: '1.0.0',
        packagePath,
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
      },
      uiPort: 18000,
      apiPort: 3737,
      token: 'test-token',
      withTui: true,
      createTuiChannel: () => tui as never,
      startUiProcess: vi.fn(() => uiProcess),
      stdout: { write: vi.fn() } as never,
    });

    finishTui();

    await expect(running).resolves.toEqual({ exitCode: 0 });
    expect(uiProcess.stop).toHaveBeenCalledOnce();
    expect(tuiHandle.stop).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('serves saved sessions from the preboot session-selection API', async () => {
    const port = 54000 + Math.floor(Math.random() * 1000);
    const sessions: SessionMeta[] = [
      {
        id: 'session-empty',
        cwd: '/repo/empty',
        startedAt: '2026-05-25T09:00:00.000Z',
        lastActivity: '2026-05-25T09:00:00.000Z',
        eventCount: 0,
        firstPrompt: null,
        provider: null,
        model: 'model',
      },
      {
        id: 'session-old',
        cwd: '/repo/one',
        startedAt: '2026-05-25T10:00:00.000Z',
        lastActivity: '2026-05-25T10:15:00.000Z',
        eventCount: 12,
        firstPrompt: 'Build the office picker',
        provider: 'openai',
        model: 'gpt-5.5',
      },
    ];
    const server = await startSessionSelectionServer({
      apiPort: port,
      token: 'test-token',
      readSessions: async () => sessions,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/session-selection`, {
        headers: { authorization: 'Bearer test-token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'selecting',
        sessions: [
          {
            id: 'session-old',
            cwd: '/repo/one',
            started_at: '2026-05-25T10:00:00.000Z',
            last_activity: '2026-05-25T10:15:00.000Z',
            event_count: 12,
            first_prompt: 'Build the office picker',
            provider: 'openai',
            model: 'gpt-5.5',
          },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it('resolves a resume selection from the preboot API', async () => {
    const port = 55000 + Math.floor(Math.random() * 1000);
    const server = await startSessionSelectionServer({
      apiPort: port,
      token: 'test-token',
      readSessions: async () => [
        {
          id: 'session-old',
          cwd: '/repo/one',
          startedAt: '2026-05-25T10:00:00.000Z',
          lastActivity: '2026-05-25T10:15:00.000Z',
          eventCount: 12,
          firstPrompt: 'Build the office picker',
          provider: 'openai',
          model: 'gpt-5.5',
        },
      ],
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/session-selection`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode: 'resume', session_id: 'session-old' }),
      });

      expect(res.status).toBe(200);
      await expect(server.selection).resolves.toEqual({
        mode: 'resume',
        sessionId: 'session-old',
      });
    } finally {
      await server.stop();
    }
  });

  it('starts the UI before booting moxxy and waits for Office session selection', async () => {
    const { packagePath } = await writeFixture();
    let resolveSelection!: (value: { mode: 'resume'; sessionId: string }) => void;
    const selection = new Promise<{ mode: 'resume'; sessionId: string }>((resolve) => {
      resolveSelection = resolve;
    });
    let finishUi!: (value: { exitCode: number }) => void;
    const uiRunning = new Promise<{ exitCode: number }>((resolve) => {
      finishUi = resolve;
    });
    const session = {
      setPermissionResolver: vi.fn(),
      close: vi.fn(async () => undefined),
      logger: {},
    };
    const bridgeResolver = { resolve: vi.fn() } as unknown as PermissionResolver;
    const bridgeHandle = {
      running: new Promise<void>(() => undefined),
      stop: vi.fn(async () => undefined),
    };
    const bridge = {
      permissionResolver: bridgeResolver,
      start: vi.fn(async () => bridgeHandle),
    };
    const bootSession = vi.fn(async () => session as never);
    const startUiProcess = vi.fn(() => ({
      running: uiRunning,
      stop: vi.fn(async () => undefined),
    }));

    const running = startUiPluginHostWithSessionSelection({
      sessionPicker: {
        selection,
        stop: vi.fn(async () => undefined),
      },
      bootSession,
      createBridge: vi.fn(() => bridge as never),
      manifest: {
        packageName: '@moxxy/virtual-office-fixture',
        packageVersion: '1.0.0',
        packagePath,
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
      },
      uiPort: 18000,
      apiPort: 3737,
      token: 'test-token',
      withTui: false,
      startUiProcess,
      stdout: { write: vi.fn() } as never,
    });

    await Promise.resolve();
    expect(startUiProcess).toHaveBeenCalledOnce();
    expect(bootSession).not.toHaveBeenCalled();

    resolveSelection({ mode: 'resume', sessionId: 'session-old' });
    await vi.waitFor(() => {
      expect(bootSession).toHaveBeenCalledWith({ mode: 'resume', sessionId: 'session-old' });
      expect(bridge.start).toHaveBeenCalledWith({ session });
    });

    finishUi({ exitCode: 0 });
    await expect(running).resolves.toEqual({ exitCode: 0 });
  });
});
