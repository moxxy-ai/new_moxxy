import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { asSessionId, asToolCallId, asTurnId } from '@moxxy/sdk';
import type { ToolContext } from '@moxxy/sdk';
import { buildBrowserSessionTool, closeBrowserSidecar, type SidecarStream } from './browser-session.js';

/**
 * The sidecar is exercised via a fake `spawnFn` that drives a scripted
 * protocol — keeps Playwright out of the test loop entirely.
 */

const baseCtx = (): ToolContext => ({
  sessionId: asSessionId('s'),
  turnId: asTurnId('t'),
  callId: asToolCallId('c'),
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

function makeFakeSpawn(handler: (req: { id: string; method: string; params?: unknown }) => unknown): {
  spawn: (path: string) => SidecarStream;
  receivedRequests: Array<{ id: string; method: string; params?: unknown }>;
} {
  const receivedRequests: Array<{ id: string; method: string; params?: unknown }> = [];

  const spawn = (_scriptPath: string): SidecarStream => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buf = '';
    stdin.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        receivedRequests.push(req);
        const result = handler(req);
        const reply = { id: req.id, ok: true, result };
        stdout.write(JSON.stringify(reply) + '\n');
      }
    });
    const exitListeners: Array<(code: number | null) => void> = [];
    const stream: SidecarStream = {
      stdin,
      stdout,
      kill: () => {
        for (const l of exitListeners) l(0);
        return true;
      },
      once: (_event, listener) => {
        exitListeners.push(listener as (code: number | null) => void);
      },
    };
    return stream;
  };
  return { spawn, receivedRequests };
}

describe('browser_session tool (sidecar protocol)', () => {
  it('drives `goto` and returns the result', async () => {
    const { spawn, receivedRequests } = makeFakeSpawn((req) => {
      if (req.method === 'goto') return { url: (req.params as { url: string }).url };
      return null;
    });

    const tool = buildBrowserSessionTool({ sidecarPath: '/fake.js', spawnFn: spawn });
    const out = await tool.handler(
      { action: { kind: 'goto', url: 'https://example.com' } },
      baseCtx(),
    );
    expect(out).toEqual({ url: 'https://example.com' });
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]!.method).toBe('goto');

    await closeBrowserSidecar();
  });

  it('drives `text` after `goto` on the same sidecar (shared page)', async () => {
    const { spawn, receivedRequests } = makeFakeSpawn((req) => {
      if (req.method === 'goto') return { url: 'https://x' };
      if (req.method === 'text') return 'hello world';
      return null;
    });

    const tool = buildBrowserSessionTool({ sidecarPath: '/fake.js', spawnFn: spawn });
    await tool.handler({ action: { kind: 'goto', url: 'https://x' } }, baseCtx());
    const text = await tool.handler({ action: { kind: 'text', selector: 'main' } }, baseCtx());
    expect(text).toBe('hello world');
    expect(receivedRequests.map((r) => r.method)).toEqual(['goto', 'text']);

    await closeBrowserSidecar();
  });

  it('forwards eval expression to the sidecar', async () => {
    const { spawn, receivedRequests } = makeFakeSpawn((req) => {
      if (req.method === 'eval') return 42;
      return null;
    });
    const tool = buildBrowserSessionTool({ sidecarPath: '/fake.js', spawnFn: spawn });
    const out = await tool.handler(
      { action: { kind: 'eval', expression: '1 + 41' } },
      baseCtx(),
    );
    expect(out).toBe(42);
    expect((receivedRequests[0]!.params as { expression: string }).expression).toBe('1 + 41');
    await closeBrowserSidecar();
  });
});
