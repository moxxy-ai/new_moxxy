import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerSocketPath, isRunnerUp } from './socket-path.js';
import { createUnixSocketServer } from './unix-socket.js';
import type { TransportServer } from './transport.js';

const servers: TransportServer[] = [];
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.MOXXY_RUNNER_SOCKET;
  delete process.env.MOXXY_RUNNER_SOCKET;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.MOXXY_RUNNER_SOCKET;
  else process.env.MOXXY_RUNNER_SOCKET = savedEnv;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('runnerSocketPath', () => {
  it('honors the MOXXY_RUNNER_SOCKET override', () => {
    process.env.MOXXY_RUNNER_SOCKET = '/tmp/custom-runner.sock';
    expect(runnerSocketPath()).toBe('/tmp/custom-runner.sock');
  });

  it('defaults to ~/.moxxy/serve.sock on non-Windows', () => {
    if (process.platform === 'win32') {
      expect(runnerSocketPath()).toContain('pipe');
    } else {
      expect(runnerSocketPath()).toBe(path.join(os.homedir(), '.moxxy', 'serve.sock'));
    }
  });
});

describe('isRunnerUp', () => {
  it('is false when nothing is listening', async () => {
    const missing = path.join(os.tmpdir(), `moxxy-absent-${Math.random().toString(36).slice(2)}.sock`);
    expect(await isRunnerUp(missing)).toBe(false);
  });

  it('is true once a server is listening, false after it closes', async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `moxxy-up-${Math.random().toString(36).slice(2)}.sock`,
    );
    const server = await createUnixSocketServer(socketPath);
    servers.push(server);
    expect(await isRunnerUp(socketPath)).toBe(true);
    await server.close();
    servers.length = 0;
    expect(await isRunnerUp(socketPath)).toBe(false);
  });
});
