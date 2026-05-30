import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MoxxyError, defineTool, z } from '@moxxy/sdk';

/**
 * Heavy-tier browser: spawns the Playwright sidecar over stdio JSON-RPC and
 * drives it through one tool. The sidecar owns one browser context per
 * process; calls within a session share the same page (back/forward/click
 * sequences work).
 *
 * Sidecar lifecycle: lazy-spawned on first invocation, kept alive for the
 * process lifetime, closed via `Session.close` (an `onShutdown` hook is
 * registered by the plugin). Playwright is an optional peer dep — sidecar
 * returns a clear error if it's not installed.
 */

type Action =
  | { kind: 'goto'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeoutMs?: number }
  | { kind: 'click'; selector: string; timeoutMs?: number }
  | { kind: 'fill'; selector: string; value: string; timeoutMs?: number }
  | { kind: 'text'; selector?: string }
  | { kind: 'html' }
  | { kind: 'screenshot'; fullPage?: boolean }
  | { kind: 'eval'; expression: string }
  | { kind: 'url' };

const actionSchema: z.ZodType<Action> = z.union([
  z.object({
    kind: z.literal('goto'),
    // `z.string().url()` accepts file:// and javascript: URLs, which would be
    // forwarded verbatim to Playwright `page.goto`. Restrict to http(s) — the
    // same scheme guard web_fetch enforces via assertPublicUrl.
    url: z.string().url().refine((u) => /^https?:\/\//i.test(u), 'only http(s) URLs allowed'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('click'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  }),
  z.object({
    kind: z.literal('fill'),
    selector: z.string().min(1),
    value: z.string(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  }),
  z.object({ kind: z.literal('text'), selector: z.string().optional() }),
  z.object({ kind: z.literal('html') }),
  z.object({ kind: z.literal('screenshot'), fullPage: z.boolean().optional() }),
  z.object({ kind: z.literal('eval'), expression: z.string().min(1) }),
  z.object({ kind: z.literal('url') }),
]);

export interface BrowserSessionDeps {
  /**
   * Override the sidecar script path. Default: resolved next to this file
   * (i.e., the `dist/sidecar.js` shipped in the same package).
   */
  readonly sidecarPath?: string;
  /**
   * Spawn override (test seam). When set, the tool will call this instead
   * of `child_process.spawn` — useful for fake sidecars.
   */
  readonly spawnFn?: (sidecarPath: string) => SidecarStream;
}

export interface SidecarStream {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): void;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
}

/**
 * Coerce a sidecar reply into an object so we can attach `notice`.
 * Wraps primitives + strings; pass-through for objects.
 */
function wrapResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

class Sidecar {
  private child: SidecarStream | null = null;
  private buffer = '';
  private readonly pending = new Map<string, PendingCall>();
  private startError: Error | null = null;
  /** Listeners for sidecar stderr lines — used by callers that want
   *  install-progress feedback in their own logger/UI. A Set (not a single
   *  slot) so concurrent browser_session calls don't clobber each other. */
  private readonly stderrListeners = new Set<(line: string) => void>();
  /** Last few sidecar stderr lines, kept so the `exit` handler can put the
   *  ACTUAL failure (e.g. "Cannot find module …" or Playwright's "Executable
   *  doesn't exist, run npx playwright install") into the error instead of a
   *  bare `code=1` the caller can't act on. */
  private readonly recentStderr: string[] = [];

  constructor(
    private readonly sidecarPath: string,
    private readonly spawnFn: (path: string) => SidecarStream,
  ) {}

  /** Subscribe to sidecar stderr lines. Returns an unsubscribe function. */
  onStderr(fn: (line: string) => void): () => void {
    this.stderrListeners.add(fn);
    return () => this.stderrListeners.delete(fn);
  }

  async ensure(): Promise<void> {
    if (this.child) return;
    if (this.startError) throw this.startError;
    try {
      this.child = this.spawnFn(this.sidecarPath);
    } catch (err) {
      this.startError = err instanceof Error ? err : new Error(String(err));
      throw this.startError;
    }
    this.child.stdout.setEncoding?.('utf8');
    this.child.stdout.on('data', (chunk: string | Buffer) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    // Forward sidecar stderr line-by-line. The sidecar uses stderr
    // for install progress ("downloading chromium…") and other
    // human-readable status; callers wire `onStderr` to surface it.
    let stderrBuf = '';
    this.child.stderr?.on?.('data', (chunk: string | Buffer) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) {
          this.recentStderr.push(line);
          if (this.recentStderr.length > 24) this.recentStderr.shift();
          for (const fn of this.stderrListeners) fn(line);
        }
      }
    });
    this.child.once('exit', (code) => {
      // Surface whatever the sidecar printed before dying — that's where the
      // real reason lives (missing module, Playwright not installed, etc.).
      const tail = this.recentStderr.slice(-8).join('\n').trim();
      const err = new MoxxyError({
        code: 'INTERNAL',
        message:
          `browser sidecar exited unexpectedly (code=${code ?? 'null'})` +
          (tail ? `:\n${tail}` : ' (no stderr captured)'),
      });
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.child = null;
    });
  }

  private handleLine(line: string): void {
    let reply: {
      id: string;
      ok: boolean;
      result?: unknown;
      error?: { message: string };
      notice?: string;
    };
    try {
      reply = JSON.parse(line);
    } catch {
      return; // ignore garbage
    }
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.ok) {
      // Attach the optional sidecar-supplied notice (e.g. "Auto-installed
      // Chromium") so the tool's caller can surface it to the user. Wrap
      // primitive results in `{ result, notice }` so the shape stays
      // useful regardless of what the original call returned.
      if (reply.notice) {
        p.resolve({ ...wrapResult(reply.result), notice: reply.notice });
      } else {
        p.resolve(reply.result);
      }
    } else {
      p.reject(
        new MoxxyError({ code: 'INTERNAL', message: reply.error?.message ?? 'sidecar error' }),
      );
    }
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensure();
    if (!this.child) throw new MoxxyError({ code: 'INTERNAL', message: 'sidecar not running' });
    if (signal?.aborted) throw new MoxxyError({ code: 'NETWORK_ABORTED', message: 'browser_session aborted' });
    const id = randomUUID();
    const req = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      // Abort cancels ONLY this pending call (rejects its promise); it does
      // NOT kill the shared singleton sidecar, which other concurrent calls
      // depend on. A late reply for this id is then ignored (not in `pending`).
      const onAbort = (): void => {
        if (this.pending.delete(id))
          reject(new MoxxyError({ code: 'NETWORK_ABORTED', message: 'browser_session aborted' }));
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.child!.stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        this.pending.delete(id);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    try {
      await this.call('close');
    } catch {
      /* ignore */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}

/** Module-level singleton: one sidecar per process. */
let SIDECAR_INSTANCE: Sidecar | null = null;

function getSidecar(deps?: BrowserSessionDeps): Sidecar {
  if (SIDECAR_INSTANCE) return SIDECAR_INSTANCE;
  const sidecarPath = deps?.sidecarPath ?? defaultSidecarPath();
  const spawnFn = deps?.spawnFn ?? defaultSpawn;
  SIDECAR_INSTANCE = new Sidecar(sidecarPath, spawnFn);
  return SIDECAR_INSTANCE;
}

/** Resolve to the sidecar JS file shipped alongside this module. */
function defaultSidecarPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'sidecar.js');
}

function defaultSpawn(scriptPath: string): SidecarStream {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

export function buildBrowserSessionTool(deps?: BrowserSessionDeps) {
  return defineTool({
    name: 'browser_session',
    description:
      'Drive a real browser (Playwright). Use for pages that need JS execution, clicks, form fills, or screenshots. For simple GETs prefer web_fetch (no extra deps). Calls within a session share one page.',
    inputSchema: z.object({
      action: actionSchema,
    }),
    permission: { action: 'prompt' },
    // Honest capability surface: browser_session spawns the Playwright sidecar
    // (a child process) which drives a real browser to arbitrary hosts and may
    // auto-install browser binaries into Playwright's cache on first use.
    // Modeled on the Bash tool's declaration — these caps are advisory until
    // @moxxy/plugin-security is enabled, at which point an isolator enforces them.
    isolation: {
      capabilities: {
        subprocess: true,
        net: { mode: 'any' },
        // Sidecar may download/unpack browser binaries into the Playwright cache.
        fs: { read: ['$cwd/**', '/tmp/**'], write: ['$cwd/**', '/tmp/**'] },
        env: ['PATH', 'HOME', 'USER', 'PLAYWRIGHT_BROWSERS_PATH'],
        timeMs: 120_000,
      },
    },
    async handler({ action }, ctx) {
      const sidecar = getSidecar(deps);
      // Surface install-progress lines (and any other sidecar status writes)
      // through this call's logger — visible in verbose mode and the event log
      // ("downloading chromium…") instead of an apparently-hung turn. onStderr
      // now supports concurrent subscribers and returns an unsubscribe.
      const offStderr = sidecar.onStderr((line) => ctx.logger.info('browser_session', { line }));
      // Per-call abort: pass ctx.signal so an abort cancels THIS call's RPC,
      // rather than calling sidecar.close() which would tear down the shared
      // singleton (and every other concurrent browser_session) on the bus.
      const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
        sidecar.call(method, params, ctx.signal);
      try {
        switch (action.kind) {
          case 'goto':
            return await call('goto', {
              url: action.url,
              waitUntil: action.waitUntil,
              timeoutMs: action.timeoutMs,
            });
          case 'click':
            return await call('click', { selector: action.selector, timeoutMs: action.timeoutMs });
          case 'fill':
            return await call('fill', {
              selector: action.selector,
              value: action.value,
              timeoutMs: action.timeoutMs,
            });
          case 'text':
            return await call('text', { selector: action.selector });
          case 'html':
            return await call('html');
          case 'screenshot':
            return await call('screenshot', { fullPage: action.fullPage });
          case 'eval':
            return await call('eval', { expression: action.expression });
          case 'url':
            return await call('url');
        }
      } finally {
        offStderr();
      }
    },
  });
}

/** Closes the singleton sidecar — wired to plugin `onShutdown`. */
export async function closeBrowserSidecar(): Promise<void> {
  if (SIDECAR_INSTANCE) {
    await SIDECAR_INSTANCE.close();
    SIDECAR_INSTANCE = null;
  }
}
