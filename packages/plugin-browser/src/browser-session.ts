import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool, z } from '@moxxy/sdk';

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
    url: z.string().url(),
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
  /** Optional listener for sidecar stderr lines — used by callers
   *  that want install-progress feedback in their own logger/UI. */
  private stderrListener: ((line: string) => void) | null = null;

  constructor(
    private readonly sidecarPath: string,
    private readonly spawnFn: (path: string) => SidecarStream,
  ) {}

  onStderr(fn: (line: string) => void): void {
    this.stderrListener = fn;
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
        if (line.trim() && this.stderrListener) this.stderrListener(line);
      }
    });
    this.child.once('exit', (code) => {
      const err = new Error(`browser sidecar exited unexpectedly (code=${code ?? 'null'})`);
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
      p.reject(new Error(reply.error?.message ?? 'sidecar error'));
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensure();
    if (!this.child) throw new Error('sidecar not running');
    const id = randomUUID();
    const req = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child!.stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        this.pending.delete(id);
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
    async handler({ action }, ctx) {
      const sidecar = getSidecar(deps);
      // Surface install-progress lines (and any other sidecar status
      // writes) through the tool ctx logger — visible in verbose mode
      // and in the event log so the operator can see "downloading
      // chromium…" instead of staring at an apparently-hung turn.
      sidecar.onStderr((line) => ctx.logger.info('browser_session', { line }));
      const onAbort = (): void => {
        void sidecar.close();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        switch (action.kind) {
          case 'goto':
            return await sidecar.call('goto', {
              url: action.url,
              waitUntil: action.waitUntil,
              timeoutMs: action.timeoutMs,
            });
          case 'click':
            return await sidecar.call('click', { selector: action.selector, timeoutMs: action.timeoutMs });
          case 'fill':
            return await sidecar.call('fill', {
              selector: action.selector,
              value: action.value,
              timeoutMs: action.timeoutMs,
            });
          case 'text':
            return await sidecar.call('text', { selector: action.selector });
          case 'html':
            return await sidecar.call('html');
          case 'screenshot':
            return await sidecar.call('screenshot', { fullPage: action.fullPage });
          case 'eval':
            return await sidecar.call('eval', { expression: action.expression });
          case 'url':
            return await sidecar.call('url');
        }
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
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
