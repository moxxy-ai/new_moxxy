import { describe, expect, it, vi } from 'vitest';
import { JsonRpcPeer, RpcError } from './jsonrpc.js';
import type { Transport } from './transport.js';

/**
 * A pair of in-memory transports wired to each other. Frames are delivered on
 * a microtask so the request/response flow mirrors a real async link without a
 * socket. Lets us test JsonRpcPeer in isolation.
 */
function makePair(): [Transport, Transport] {
  let aOnFrame: ((f: unknown) => void) | undefined;
  let bOnFrame: ((f: unknown) => void) | undefined;
  let aOnClose: ((e?: Error) => void) | undefined;
  let bOnClose: ((e?: Error) => void) | undefined;
  let closed = false;
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      aOnClose?.();
      bOnClose?.();
    });
  };
  const a: Transport = {
    send: (f) => {
      if (!closed) queueMicrotask(() => bOnFrame?.(f));
    },
    onFrame: (h) => {
      aOnFrame = h;
    },
    onClose: (h) => {
      aOnClose = h;
    },
    close: closeBoth,
  };
  const b: Transport = {
    send: (f) => {
      if (!closed) queueMicrotask(() => aOnFrame?.(f));
    },
    onFrame: (h) => {
      bOnFrame = h;
    },
    onClose: (h) => {
      bOnClose = h;
    },
    close: closeBoth,
  };
  return [a, b];
}

describe('JsonRpcPeer', () => {
  it('resolves a request with the handler return value', async () => {
    const [ta, tb] = makePair();
    const client = new JsonRpcPeer(ta);
    const server = new JsonRpcPeer(tb);
    server.handle('add', (params) => {
      const { a, b } = params as { a: number; b: number };
      return a + b;
    });
    await expect(client.request('add', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('supports requests in both directions (server->client)', async () => {
    const [ta, tb] = makePair();
    const client = new JsonRpcPeer(ta);
    const server = new JsonRpcPeer(tb);
    client.handle('whoami', () => 'the-client');
    await expect(server.request('whoami')).resolves.toBe('the-client');
  });

  it('delivers notifications without a reply', async () => {
    const [ta, tb] = makePair();
    const client = new JsonRpcPeer(ta);
    const server = new JsonRpcPeer(tb);
    const seen = vi.fn();
    server.on('ping', (params) => seen(params));
    client.notify('ping', { n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveBeenCalledWith({ n: 1 });
  });

  it('propagates a handler throw as an RpcError carrying the message', async () => {
    const [ta, tb] = makePair();
    const client = new JsonRpcPeer(ta);
    const server = new JsonRpcPeer(tb);
    server.handle('boom', () => {
      throw new Error('kaboom');
    });
    await expect(client.request('boom')).rejects.toBeInstanceOf(RpcError);
    await expect(client.request('boom')).rejects.toThrow('kaboom');
  });

  it('rejects requests for unknown methods', async () => {
    const [ta, tb] = makePair();
    const client = new JsonRpcPeer(ta);
    // server peer exists but registers nothing
    new JsonRpcPeer(tb);
    await expect(client.request('nope')).rejects.toThrow(/unknown method: nope/);
  });

  it('rejects in-flight requests when the link closes', async () => {
    const [ta, tb] = makePair();
    const client = new JsonRpcPeer(ta);
    const server = new JsonRpcPeer(tb);
    // Handler that never replies, so the request is pending when we close.
    server.handle('hang', () => new Promise<never>(() => undefined));
    const pending = client.request('hang');
    client.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('rejects new requests once closed', async () => {
    const [ta] = makePair();
    const client = new JsonRpcPeer(ta);
    client.close();
    await new Promise((r) => setTimeout(r, 5));
    await expect(client.request('x')).rejects.toThrow(/closed/);
    expect(client.isClosed).toBe(true);
  });

  it('runs onClose handlers (and immediately if already closed)', async () => {
    const [ta] = makePair();
    const client = new JsonRpcPeer(ta);
    const cb = vi.fn();
    client.close();
    await new Promise((r) => setTimeout(r, 5));
    // registering after close still fires
    client.onClose(cb);
    expect(cb).toHaveBeenCalled();
  });
});
