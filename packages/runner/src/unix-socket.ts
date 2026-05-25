import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { Transport, TransportServer } from './transport.js';

/**
 * NDJSON framing over a single `net.Socket`: one JSON value per line. Safe
 * because `JSON.stringify` never emits a raw newline, so `\n` is an
 * unambiguous frame delimiter. Sockets are set to UTF-8 so base64 attachment
 * payloads ride through as text intact.
 */
class NdjsonTransport implements Transport {
  private buffer = '';
  private frameHandler: ((frame: unknown) => void) | undefined;
  private closeHandler: ((err?: Error) => void) | undefined;
  private closedEmitted = false;

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.emitClose());
    socket.on('error', (err) => this.emitClose(err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Drop malformed frames rather than tearing the link down.
          parsed = undefined;
        }
        if (parsed !== undefined) this.frameHandler?.(parsed);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private emitClose(err?: Error): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.closeHandler?.(err);
  }

  send(frame: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  onFrame(handler: (frame: unknown) => void): void {
    this.frameHandler = handler;
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.socket.end();
  }
}

/**
 * Listen on a local socket (unix domain socket, or named pipe on Windows).
 *
 * Stale-socket recovery: a crashed runner leaves the socket file behind on
 * unix. We probe it - if nothing answers (`ECONNREFUSED`), it's stale and we
 * unlink before binding. If something *does* answer, the address is genuinely
 * in use and we surface `EADDRINUSE`. Named pipes self-clean, so this only
 * runs on non-Windows.
 */
export async function createUnixSocketServer(socketPath: string): Promise<TransportServer> {
  if (process.platform !== 'win32') {
    await reclaimStaleSocket(socketPath);
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  }

  const connectionHandlers: Array<(t: Transport) => void> = [];
  const server = net.createServer((socket) => {
    const transport = new NdjsonTransport(socket);
    for (const handler of connectionHandlers) handler(transport);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Restrict to the owning user. No-op on Windows (named pipe ACLs differ).
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // Best effort - some filesystems reject chmod on sockets.
    }
  }

  return {
    address: socketPath,
    onConnection(handler) {
      connectionHandlers.push(handler);
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => {
          if (process.platform !== 'win32') {
            try {
              fs.unlinkSync(socketPath);
            } catch {
              // already gone
            }
          }
          resolve();
        });
      });
    },
  };
}

/** Connect to a runner's socket, returning a {@link Transport} once open. */
export function connectUnixSocket(socketPath: string): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const socket = net.connect(socketPath);
    const onError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(new NdjsonTransport(socket));
    });
  });
}

async function reclaimStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    const finish = (up: boolean): void => {
      probe.destroy();
      resolve(up);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
  });
  if (!alive) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // racing another reclaimer - fine
    }
  }
}
