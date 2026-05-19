export type BrowserKind = 'chromium' | 'firefox' | 'webkit';

export type ErrorKind = 'init' | 'navigation' | 'runtime' | 'timeout' | 'unknown';

export interface Req {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface Ok {
  readonly id: string;
  readonly ok: true;
  readonly result?: unknown;
  /** One-shot human-readable note (e.g. "Auto-installed Chromium"). */
  readonly notice?: string;
}

export interface Err {
  readonly id: string;
  readonly ok: false;
  readonly error: { message: string; kind: ErrorKind };
}

export type Reply = Ok | Err;

export interface BrowserType {
  launch(opts: {
    headless: boolean;
  }): Promise<{ close(): Promise<void>; newContext(): Promise<unknown> }>;
}

export interface PageHandle {
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

export interface PlaywrightHandle {
  // Loosely typed so we can avoid importing the playwright types at compile time —
  // they're an optional peer dependency.
  readonly browser: { close(): Promise<void> };
  readonly context: {
    newPage(): Promise<unknown>;
    close(): Promise<void>;
  };
  readonly page: PageHandle;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function badParams(msg: string): Error {
  const e = new Error(msg);
  (e as Error & { kind?: string }).kind = 'runtime';
  return e;
}
