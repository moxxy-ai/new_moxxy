import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUnixSocketServer, connectUnixSocket } from './unix-socket.js';
import type { Transport, TransportServer } from './transport.js';

function tmpSocket(): string {
  return path.join(os.tmpdir(), `moxxy-sock-${Math.random().toString(36).slice(2, 10)}.sock`);
}

const servers: TransportServer[] = [];
const transports: Transport[] = [];

afterEach(async () => {
  for (const t of transports.splice(0)) t.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Collect the next frame a transport receives. */
function nextFrame(t: Transport): Promise<unknown> {
  return new Promise((resolve) => t.onFrame((f) => resolve(f)));
}

describe('unix-socket transport (NDJSON framing)', () => {
  it('round-trips a JSON frame client->server and server->client', async () => {
    const socketPath = tmpSocket();
    const server = await createUnixSocketServer(socketPath);
    servers.push(server);

    const serverSide = new Promise<Transport>((resolve) => server.onConnection(resolve));
    const client = await connectUnixSocket(socketPath);
    transports.push(client);
    const srv = await serverSide;

    const gotOnServer = nextFrame(srv);
    client.send({ hello: 'world', n: 42 });
    expect(await gotOnServer).toEqual({ hello: 'world', n: 42 });

    const gotOnClient = nextFrame(client);
    srv.send({ reply: true });
    expect(await gotOnClient).toEqual({ reply: true });
  });

  it('preserves order and boundaries for several frames sent back-to-back', async () => {
    const socketPath = tmpSocket();
    const server = await createUnixSocketServer(socketPath);
    servers.push(server);
    const serverSide = new Promise<Transport>((resolve) => server.onConnection(resolve));
    const client = await connectUnixSocket(socketPath);
    transports.push(client);
    const srv = await serverSide;

    const received: unknown[] = [];
    srv.onFrame((f) => received.push(f));
    for (let i = 0; i < 5; i++) client.send({ i });
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }]);
  });

  it('reassembles a frame split across two writes', async () => {
    const socketPath = tmpSocket();
    const server = await createUnixSocketServer(socketPath);
    servers.push(server);
    const serverSide = new Promise<Transport>((resolve) => server.onConnection(resolve));
    // Raw client so we can write a partial line then the rest.
    const raw = net.connect(socketPath);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    const srv = await serverSide;
    const got = nextFrame(srv);
    const payload = JSON.stringify({ big: 'x'.repeat(1000) });
    raw.write(payload.slice(0, 100));
    await new Promise((r) => setTimeout(r, 10));
    raw.write(payload.slice(100) + '\n');
    expect(await got).toEqual({ big: 'x'.repeat(1000) });
    raw.destroy();
  });

  it('reclaims a stale socket file left by a crashed runner', async () => {
    const socketPath = tmpSocket();
    // Simulate a leftover file with nothing listening.
    fs.writeFileSync(socketPath, '');
    expect(fs.existsSync(socketPath)).toBe(true);
    // Should unlink the stale file and bind cleanly.
    const server = await createUnixSocketServer(socketPath);
    servers.push(server);
    // Register the connection handler BEFORE connecting so we don't miss it.
    const serverSide = new Promise<Transport>((resolve) => server.onConnection(resolve));
    const client = await connectUnixSocket(socketPath);
    transports.push(client);
    const srv = await serverSide;
    const got = nextFrame(srv);
    client.send({ ok: 1 });
    expect(await got).toEqual({ ok: 1 });
  });

  it('fires onClose when the peer disconnects', async () => {
    const socketPath = tmpSocket();
    const server = await createUnixSocketServer(socketPath);
    servers.push(server);
    const serverSide = new Promise<Transport>((resolve) => server.onConnection(resolve));
    const client = await connectUnixSocket(socketPath);
    const srv = await serverSide;
    const closed = new Promise<void>((resolve) => srv.onClose(() => resolve()));
    client.close();
    await expect(closed).resolves.toBeUndefined();
  });
});
