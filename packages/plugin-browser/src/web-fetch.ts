import { defineTool, z } from '@moxxy/sdk';
import { htmlToMarkdown, htmlToPlainText } from './html-extract.js';

/**
 * Light-tier web fetch: a single HTTP GET (or HEAD) with HTML→text/markdown
 * post-processing for the common case of "read this page". Zero new
 * dependencies — uses Node's built-in `fetch`.
 *
 * For JS-heavy / interactive pages, use `browser_session` (Playwright
 * sidecar) instead. The web-research skill picks the tier.
 */

export { htmlToMarkdown, htmlToPlainText } from './html-extract.js';

const MAX_BYTES_DEFAULT = 2 * 1024 * 1024; // 2 MB
const MAX_REDIRECTS_DEFAULT = 5;
const FETCH_TIMEOUT_MS_DEFAULT = 20_000;

export const webFetchTool = defineTool({
  name: 'web_fetch',
  description:
    'Fetch a URL over HTTP(S) and return the page content. HTML is post-processed to readable text (or markdown). Use for simple GETs; if the page needs JS execution, clicks, or form fills, use browser_session instead.',
  inputSchema: z.object({
    url: z.string().url().describe('Absolute http:// or https:// URL.'),
    format: z
      .enum(['text', 'markdown', 'raw'])
      .optional()
      .default('text')
      .describe(
        'How to render the response. `text` strips HTML to readable plain text. `markdown` keeps headings + lists + links. `raw` returns the body as-is (HTML, JSON, etc).',
      ),
    method: z.enum(['GET', 'HEAD']).optional().default('GET'),
    headers: z.record(z.string(), z.string()).optional(),
    maxBytes: z.number().int().positive().max(20_000_000).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    selector: z
      .string()
      .optional()
      .describe(
        'Optional CSS-like selector for the readability extractor (e.g. "main", "article"). Falls back to whole-body extraction.',
      ),
  }),
  permission: { action: 'prompt' },
  isolation: {
    capabilities: {
      net: { mode: 'any' },
      timeMs: 120_000,
    },
  },
  async handler({ url, format, method, headers, maxBytes, timeoutMs, selector }, ctx) {
    const cap = maxBytes ?? MAX_BYTES_DEFAULT;
    const timeout = timeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;

    const aborter = new AbortController();
    const onParentAbort = (): void => aborter.abort('parent signal');
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => aborter.abort('fetch timeout'), timeout);

    try {
      const res = await fetchFollowRedirects(url, {
        method,
        headers: { 'user-agent': 'moxxy/0.0', ...(headers ?? {}) },
        signal: aborter.signal,
        maxRedirects: MAX_REDIRECTS_DEFAULT,
      });

      if (method === 'HEAD') {
        return formatHeadResult(res);
      }

      const body = await readCapped(res, cap);
      const contentType = res.headers.get('content-type') ?? '';
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');

      if (format === 'raw' || !isHtml) {
        return formatBodyResult({
          status: res.status,
          url: res.url,
          contentType,
          body,
          truncated: body.truncated,
        });
      }

      const extracted =
        format === 'markdown'
          ? htmlToMarkdown(body.text, { selector })
          : htmlToPlainText(body.text, { selector });
      return formatBodyResult({
        status: res.status,
        url: res.url,
        contentType,
        body: { text: extracted, truncated: body.truncated },
        truncated: body.truncated,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParentAbort);
    }
  },
});

interface FetchResult {
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

async function fetchFollowRedirects(
  initialUrl: string,
  opts: {
    method: 'GET' | 'HEAD';
    headers: Record<string, string>;
    signal: AbortSignal;
    maxRedirects: number;
  },
): Promise<FetchResult> {
  let current = initialUrl;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await fetch(current, {
      method: opts.method,
      headers: opts.headers,
      signal: opts.signal,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, current).toString();
      current = next;
      // drain to avoid the connection leaking
      try { await res.body?.cancel(); } catch { /* ignore */ }
      continue;
    }
    return {
      status: res.status,
      url: current,
      headers: res.headers,
      body: res.body,
    };
  }
  throw new Error(`Too many redirects (>${opts.maxRedirects}) starting at ${initialUrl}`);
}

interface CappedBody {
  readonly text: string;
  readonly truncated: boolean;
}

async function readCapped(res: FetchResult, cap: number): Promise<CappedBody> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        chunks.push(value.subarray(0, cap - total));
        total = cap;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    try { await res.body.cancel(); } catch { /* ignore */ }
  }
  const buf = Buffer.concat(chunks.map((u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)));
  return { text: buf.toString('utf8'), truncated };
}

function formatHeadResult(res: FetchResult): string {
  const lines = [`HTTP ${res.status} ${res.url}`];
  for (const [k, v] of res.headers.entries()) lines.push(`${k}: ${v}`);
  return lines.join('\n');
}

interface BodyResult {
  status: number;
  url: string;
  contentType: string;
  body: CappedBody;
  truncated: boolean;
}

function formatBodyResult(r: BodyResult): string {
  const header = `HTTP ${r.status} ${r.url}\ncontent-type: ${r.contentType}${
    r.truncated ? '\n[response truncated]' : ''
  }`;
  return `${header}\n\n${r.body.text}`;
}

