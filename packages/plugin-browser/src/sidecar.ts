#!/usr/bin/env node
/**
 * Playwright sidecar — owns a single browser context. Speaks newline-delimited
 * JSON-RPC over stdio so the parent (`browser_session` tool) doesn't load
 * Playwright into its own process. Crash isolation, lazy install: the parent
 * only spawns this when the heavy tier is actually needed.
 *
 * Wire format (one line per message):
 *   { "id": "uuid", "method": "goto"|"click"|"fill"|"text"|"html"|"screenshot"|"eval"|"close", "params": {...} }
 *   { "id": "uuid", "ok": true,  "result": ... }
 *   { "id": "uuid", "ok": false, "error": { "message": "...", "kind": "init"|"navigation"|"runtime"|"timeout" } }
 *
 * Run with `node dist/sidecar.js` (the package's `bin` entry is
 * `moxxy-browser-sidecar`). Parent terminates by closing stdin or sending
 * `{method:'close'}`.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

interface Req {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface Ok {
  readonly id: string;
  readonly ok: true;
  readonly result?: unknown;
  /** One-shot human-readable note (e.g. "Auto-installed Chromium"). */
  readonly notice?: string;
}

interface Err {
  readonly id: string;
  readonly ok: false;
  readonly error: { message: string; kind: 'init' | 'navigation' | 'runtime' | 'timeout' | 'unknown' };
}

type Reply = Ok | Err;

interface PlaywrightHandle {
  // Loosely typed so we can avoid importing the playwright types at compile time —
  // they're an optional peer dependency.
  readonly browser: { close(): Promise<void> };
  readonly context: {
    newPage(): Promise<unknown>;
    close(): Promise<void>;
  };
  readonly page: PageHandle;
}

interface PageHandle {
  goto(url: string, opts?: unknown): Promise<unknown>;
  click(selector: string, opts?: unknown): Promise<void>;
  fill(selector: string, value: string, opts?: unknown): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  content(): Promise<string>;
  screenshot(opts?: unknown): Promise<Buffer>;
  evaluate(fn: string): Promise<unknown>;
  url(): string;
  close(): Promise<void>;
}

let handle: PlaywrightHandle | null = null;
/**
 * Set after a successful auto-install of browser binaries so the next
 * tool result can carry a `notice` letting the user/model know the
 * one-time download happened. Cleared once the notice has been
 * delivered (handed to the reply once, then forgotten).
 */
let pendingInstallNotice: string | null = null;

async function ensurePlaywright(opts: { browser?: 'chromium' | 'firefox' | 'webkit'; headless?: boolean }): Promise<PlaywrightHandle> {
  if (handle) return handle;
  let pw: { chromium: BrowserType; firefox: BrowserType; webkit: BrowserType };
  try {
    pw = (await import('playwright')) as never;
  } catch (err) {
    const e = new Error(
      `Playwright is not installed. Run \`pnpm add playwright\` (or \`npm i playwright\`) and then \`npx playwright install\` in the moxxy install dir.\n` +
        `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
    (e as Error & { kind?: string }).kind = 'init';
    throw e;
  }
  const which = opts.browser ?? 'chromium';
  const browserType: BrowserType = pw[which];
  handle = await launchWithAutoInstall(browserType, which, opts.headless ?? true);
  return handle;
}

/**
 * Try to launch the browser. If the binary isn't downloaded yet
 * (Playwright distinguishes the npm install from the per-browser
 * binary download), run `npx playwright install <which>` once and
 * retry. The install can take 30s–2min on the first run depending on
 * connection; we surface progress on stderr (parent forwards to the
 * logger) and stash a one-shot notice for the first tool response.
 */
async function launchWithAutoInstall(
  browserType: BrowserType,
  which: 'chromium' | 'firefox' | 'webkit',
  headless: boolean,
): Promise<PlaywrightHandle> {
  try {
    return await launchOnce(browserType, headless);
  } catch (err) {
    if (!isMissingBrowserError(err)) throw err;
    process.stderr.write(
      `moxxy-browser: ${which} binary missing, running \`npx playwright install ${which}\` ` +
        `(one-time, ~150MB). This may take a minute…\n`,
    );
    try {
      await runPlaywrightInstall(which);
    } catch (installErr) {
      const msg = installErr instanceof Error ? installErr.message : String(installErr);
      const e = new Error(
        `Playwright browser auto-install failed: ${msg}. ` +
          `Run \`npx playwright install ${which}\` manually in the moxxy dir.`,
      );
      (e as Error & { kind?: string }).kind = 'init';
      throw e;
    }
    pendingInstallNotice = `Auto-installed Playwright ${which} browser (~150MB, one-time).`;
    process.stderr.write(`moxxy-browser: install complete, retrying launch\n`);
    return await launchOnce(browserType, headless);
  }
}

async function launchOnce(browserType: BrowserType, headless: boolean): Promise<PlaywrightHandle> {
  const browser = await browserType.launch({ headless });
  const context = (await browser.newContext()) as PlaywrightHandle['context'];
  const page = (await context.newPage()) as unknown as PageHandle;
  return { browser, context, page };
}

function isMissingBrowserError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Playwright's "Executable doesn't exist at …" launch error fires
  // when the npm package is installed but the per-browser binary
  // hasn't been downloaded. The message stays stable across versions.
  return /Executable doesn'?t exist at/i.test(err.message);
}

/**
 * Run `npx playwright install <which>` and stream its output to the
 * sidecar's stderr so the operator can watch progress. Resolves on
 * exit-0; rejects with the tail of stderr otherwise.
 */
function runPlaywrightInstall(which: 'chromium' | 'firefox' | 'webkit'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'install', which], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    child.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });
    child.once('error', (err) => reject(err));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderrTail.trim() || '(no stderr)'}`));
    });
  });
}

interface BrowserType {
  launch(opts: { headless: boolean }): Promise<{ close(): Promise<void>; newContext(): Promise<unknown> }>;
}

async function dispatch(req: Req): Promise<Reply> {
  try {
    switch (req.method) {
      case 'init': {
        const opts = (req.params ?? {}) as { browser?: 'chromium' | 'firefox' | 'webkit'; headless?: boolean };
        await ensurePlaywright(opts);
        return { id: req.id, ok: true, result: { ready: true } };
      }
      case 'goto': {
        const h = await ensurePlaywright({});
        const { url, waitUntil, timeoutMs } = (req.params ?? {}) as {
          url: string;
          waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
          timeoutMs?: number;
        };
        if (!url) throw badParams('url is required');
        try {
          await h.page.goto(url, { waitUntil: waitUntil ?? 'domcontentloaded', timeout: timeoutMs ?? 30_000 });
        } catch (err) {
          return { id: req.id, ok: false, error: { message: errMsg(err), kind: 'navigation' } };
        }
        return { id: req.id, ok: true, result: { url: h.page.url() } };
      }
      case 'click': {
        const h = await ensurePlaywright({});
        const { selector, timeoutMs } = (req.params ?? {}) as { selector: string; timeoutMs?: number };
        if (!selector) throw badParams('selector is required');
        await h.page.click(selector, { timeout: timeoutMs ?? 10_000 });
        return { id: req.id, ok: true };
      }
      case 'fill': {
        const h = await ensurePlaywright({});
        const { selector, value, timeoutMs } = (req.params ?? {}) as {
          selector: string;
          value: string;
          timeoutMs?: number;
        };
        if (!selector) throw badParams('selector is required');
        await h.page.fill(selector, value ?? '', { timeout: timeoutMs ?? 10_000 });
        return { id: req.id, ok: true };
      }
      case 'text': {
        const h = await ensurePlaywright({});
        const { selector } = (req.params ?? {}) as { selector?: string };
        if (selector) {
          const text = await h.page.textContent(selector);
          return { id: req.id, ok: true, result: text ?? '' };
        }
        // Whole-document text via evaluate
        const text = (await h.page.evaluate('document.body ? document.body.innerText : ""')) as string;
        return { id: req.id, ok: true, result: text };
      }
      case 'html': {
        const h = await ensurePlaywright({});
        const html = await h.page.content();
        return { id: req.id, ok: true, result: html };
      }
      case 'screenshot': {
        const h = await ensurePlaywright({});
        const { fullPage } = (req.params ?? {}) as { fullPage?: boolean };
        const buf = await h.page.screenshot({ fullPage: fullPage ?? false });
        return { id: req.id, ok: true, result: { mediaType: 'image/png', base64: buf.toString('base64') } };
      }
      case 'eval': {
        const h = await ensurePlaywright({});
        const { expression } = (req.params ?? {}) as { expression: string };
        if (!expression) throw badParams('expression is required');
        const value = await h.page.evaluate(expression);
        return { id: req.id, ok: true, result: value };
      }
      case 'url': {
        const h = await ensurePlaywright({});
        return { id: req.id, ok: true, result: h.page.url() };
      }
      case 'close': {
        if (handle) {
          try {
            await handle.context.close();
            await handle.browser.close();
          } catch {
            /* ignore */
          }
          handle = null;
        }
        return { id: req.id, ok: true };
      }
      default:
        return {
          id: req.id,
          ok: false,
          error: { message: `unknown method: ${req.method}`, kind: 'runtime' },
        };
    }
  } catch (err) {
    const kind = (err as Error & { kind?: string }).kind;
    return {
      id: req.id,
      ok: false,
      error: { message: errMsg(err), kind: (kind as Err['error']['kind']) ?? 'unknown' },
    };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function badParams(msg: string): Error {
  const e = new Error(msg);
  (e as Error & { kind?: string }).kind = 'runtime';
  return e;
}

function write(reply: Reply): void {
  // Drain the install-notice flag into the first reply that goes out
  // after the install completed, then clear it. Errors get the notice
  // too — sometimes the launch retry surfaces a different problem and
  // the user still wants to know we tried to install.
  if (pendingInstallNotice) {
    if (reply.ok) {
      reply = { ...reply, notice: pendingInstallNotice };
    } else {
      reply = {
        ...reply,
        error: {
          ...reply.error,
          message: `${pendingInstallNotice} Then: ${reply.error.message}`,
        },
      };
    }
    pendingInstallNotice = null;
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
}

/**
 * Tears down the browser context AND exits the process. Used both by
 * the explicit `close` RPC path and the parent-loss / stdin-close
 * paths so all cleanup goes through one routine.
 */
async function shutdownAndExit(code: number): Promise<void> {
  if (handle) {
    try {
      await handle.context.close();
      await handle.browser.close();
    } catch {
      /* ignore */
    }
    handle = null;
  }
  process.exit(code);
}

/**
 * Parent watchdog: if the moxxy process that spawned this sidecar
 * disappears (crash, SIGKILL, terminal hangup), there's no stdin EOF
 * to rely on — orphan Chromium would keep running and chew CPU/memory
 * until the user notices. Poll the parent PID every few seconds and
 * self-terminate when it goes away.
 *
 * `process.kill(pid, 0)` is the POSIX trick for "does this PID
 * exist?" — no signal is actually delivered. Throws ESRCH when the
 * process is gone (or EPERM when it exists but we can't signal it —
 * still alive, so don't treat as gone).
 */
function startParentWatchdog(): void {
  const parentPid = process.ppid;
  if (!parentPid || parentPid <= 1) return; // already orphaned (init), nothing to watch
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        clearInterval(interval);
        void shutdownAndExit(0);
      }
      // EPERM means the process exists but we can't signal it — still alive.
    }
  }, 2000);
  interval.unref?.(); // never block the event loop from exiting
}

async function main(): Promise<void> {
  startParentWatchdog();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: Req;
    try {
      req = JSON.parse(line) as Req;
    } catch {
      write({ id: 'unknown', ok: false, error: { message: 'invalid JSON', kind: 'runtime' } });
      return;
    }
    if (!req.id || !req.method) {
      write({
        id: req.id ?? 'unknown',
        ok: false,
        error: { message: 'request requires { id, method }', kind: 'runtime' },
      });
      return;
    }
    // Sequentially serve requests on the single page. Parent can pipeline by
    // sending more requests; we serialize them inside the sidecar so a goto
    // doesn't race a click.
    queue = queue.then(async () => {
      const reply = await dispatch(req);
      write(reply);
    });
  });
  rl.once('close', () => {
    void shutdownAndExit(0);
  });
  // Defensive: if our stdout pipe breaks (parent died mid-write), Node
  // would otherwise throw an uncaught EPIPE on the next write. Treat
  // it as a signal to clean up gracefully instead.
  process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
      void shutdownAndExit(0);
    }
  });
}

let queue: Promise<void> = Promise.resolve();

main().catch((err) => {
  process.stderr.write(`sidecar fatal: ${errMsg(err)}\n`);
  void shutdownAndExit(1);
});
