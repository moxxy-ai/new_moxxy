import { createServer, type Server } from 'node:http';

interface WaitForCallbackOpts {
  readonly port: number;
  readonly path: string;
  readonly expectedState: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export function waitForCallback(opts: WaitForCallbackOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let server: Server | null = null;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (server) server.close();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`OAuth callback timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      settle(() => reject(new Error('OAuth flow aborted')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
      if (url.pathname !== opts.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const err = url.searchParams.get('error');
      const errDesc = url.searchParams.get('error_description');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage('OAuth error', `${err}${errDesc ? `: ${errDesc}` : ''}`));
        clearTimeout(timer);
        settle(() => reject(new Error(`OAuth error: ${err}${errDesc ? ` — ${errDesc}` : ''}`)));
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code || !returnedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage('OAuth error', 'callback was missing code or state'));
        clearTimeout(timer);
        settle(() => reject(new Error('OAuth callback missing code or state')));
        return;
      }
      if (returnedState !== opts.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage('OAuth error', 'state mismatch — possible CSRF, refusing'));
        clearTimeout(timer);
        settle(() => reject(new Error('OAuth state mismatch')));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Authorized', 'You can close this window — moxxy received the token.'));
      clearTimeout(timer);
      settle(() => resolve(code));
    });
    server.on('error', (e) => {
      clearTimeout(timer);
      settle(() => reject(e));
    });
    server.listen(opts.port, '127.0.0.1');
  });
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}h1{font-weight:300}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
