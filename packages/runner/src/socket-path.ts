import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Address of the runner's listening socket. The single place that knows about
 * the OS difference: a filesystem socket on unix, a named pipe on Windows
 * (`node:net` maps "listen on a path" to a named pipe there). Everything above
 * the transport is platform-agnostic.
 *
 * `MOXXY_RUNNER_SOCKET` overrides it - useful for tests and for running
 * multiple isolated runners on one machine.
 */
export function runnerSocketPath(): string {
  const override = process.env.MOXXY_RUNNER_SOCKET;
  if (override) return override;
  if (process.platform === 'win32') return '\\\\.\\pipe\\moxxy-serve';
  return path.join(os.homedir(), '.moxxy', 'serve.sock');
}

/**
 * Probe whether a runner is currently listening. Used by channel commands to
 * decide attach-vs-self-host. A connect that succeeds means "up"; any error
 * (ENOENT, ECONNREFUSED) means "no runner".
 */
export function isRunnerUp(socketPath: string = runnerSocketPath()): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
