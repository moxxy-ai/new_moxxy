import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Generic local-callback HTTP server for OAuth Authorization Code flows.
 * Boots on `localhost:<port>`, awaits a single GET to <redirectPath>, and
 * either resolves with the `code` parameter or rejects (state mismatch,
 * upstream error, timeout). The caller is responsible for calling `stop()`
 * to free the port.
 *
 * This is provider-agnostic — future OAuth providers (Anthropic Claude.ai
 * plan, etc.) can reuse it by passing their own state and redirectPath.
 */
export interface CallbackServerOpts {
  readonly port: number;
  readonly expectedState: string;
  readonly redirectPath?: string;
  readonly successHtml?: string;
  readonly errorHtml?: (err: string) => string;
}

export interface CallbackServer {
  readonly redirectUri: string;
  waitForCode(timeoutMs: number): Promise<string>;
  stop(): void;
}

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html><head><title>moxxy — login successful</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0b0b0b;color:#f1ecec}
.c{text-align:center;padding:2rem}h1{margin-bottom:.5rem}p{color:#a39c9c}</style></head>
<body><div class="c"><h1>Login successful</h1><p>You can close this window and return to moxxy.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

const DEFAULT_ERROR_HTML = (err: string) => `<!doctype html>
<html><head><title>moxxy — login failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0b0b0b;color:#f1ecec}
.c{text-align:center;padding:2rem}h1{color:#fc533a;margin-bottom:.5rem}p{color:#a39c9c}
.e{color:#ff917b;font-family:monospace;margin-top:1rem;padding:1rem;background:#3c140d;border-radius:.5rem}</style></head>
<body><div class="c"><h1>Login failed</h1><p>An error occurred during authorization.</p><div class="e">${escapeHtml(err)}</div></div></body></html>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function startCallbackServer(opts: CallbackServerOpts): Promise<CallbackServer> {
  const path = opts.redirectPath ?? '/auth/callback';
  const successHtml = opts.successHtml ?? DEFAULT_SUCCESS_HTML;
  const errorHtml = opts.errorHtml ?? DEFAULT_ERROR_HTML;
  const redirectUri = `http://localhost:${opts.port}${path}`;

  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
    if (url.pathname !== path) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDesc = url.searchParams.get('error_description');

    if (error) {
      const msg = errorDesc || error;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml(msg));
      rejectCode?.(new Error(`OAuth error: ${msg}`));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml('Missing authorization code'));
      rejectCode?.(new Error('OAuth callback missing code parameter'));
      return;
    }
    if (state !== opts.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml('Invalid state — potential CSRF attack'));
      rejectCode?.(new Error('OAuth state mismatch'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(successHtml);
    resolveCode?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    redirectUri,
    waitForCode(timeoutMs: number): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolveCode = undefined;
          rejectCode = undefined;
          reject(new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        resolveCode = (code) => {
          clearTimeout(timer);
          resolve(code);
        };
        rejectCode = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
    },
    stop(): void {
      server.close();
    },
  };
}
