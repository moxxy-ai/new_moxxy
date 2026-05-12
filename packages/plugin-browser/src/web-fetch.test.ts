import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { htmlToMarkdown, htmlToPlainText, webFetchTool } from './web-fetch.js';
import { asSessionId, asToolCallId, asTurnId } from '@moxxy/sdk';
import type { ToolContext } from '@moxxy/sdk';

const baseCtx = (): ToolContext => ({
  sessionId: asSessionId('s'),
  turnId: asTurnId('t'),
  callId: asToolCallId('c'),
  cwd: '/tmp',
  signal: new AbortController().signal,
  log: { length: 0, at: () => undefined, slice: () => [], ofType: () => [], byTurn: () => [], toJSON: () => [] },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

describe('htmlToPlainText', () => {
  it('strips tags + scripts + styles', () => {
    const html = `
      <html><head><style>body{color:red}</style></head>
      <body>
        <script>alert('xss')</script>
        <h1>Title</h1>
        <p>Para one.</p>
        <p>Para <b>two</b>.</p>
      </body></html>`;
    const text = htmlToPlainText(html);
    expect(text).toContain('Title');
    expect(text).toContain('Para one.');
    expect(text).toContain('Para two.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('<p>a&amp;b &lt; c &gt; d &quot;e&quot;</p>')).toBe('a&b < c > d "e"');
  });

  it('extracts a selector block when provided', () => {
    const html = '<div>outside</div><main>inside main</main><footer>footer</footer>';
    expect(htmlToPlainText(html, { selector: 'main' })).toBe('inside main');
  });

  it('selector by id', () => {
    const html = '<p>noise</p><div id="content">payload</div><p>noise2</p>';
    expect(htmlToPlainText(html, { selector: '#content' })).toBe('payload');
  });
});

describe('htmlToMarkdown', () => {
  it('emits markdown headings, lists, links', () => {
    const html = `
      <h1>Title</h1>
      <p>Intro.</p>
      <ul><li>one</li><li>two</li></ul>
      <p>See <a href="https://example.com">example</a>.</p>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('# Title');
    expect(md).toContain('- one');
    expect(md).toContain('- two');
    expect(md).toContain('[example](https://example.com)');
  });
});

describe('web_fetch handler', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns text body for an HTML page', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse('<html><body><h1>Hello</h1></body></html>', { 'content-type': 'text/html' }),
    ) as never;

    const out = (await webFetchTool.handler(
      { url: 'https://example.com', format: 'text', method: 'GET' },
      baseCtx(),
    )) as string;
    expect(out).toContain('HTTP 200');
    expect(out).toContain('Hello');
  });

  it('returns raw body for non-HTML content-type', async () => {
    const body = '{"ok":true}';
    globalThis.fetch = vi.fn(async () =>
      mkResponse(body, { 'content-type': 'application/json' }),
    ) as never;

    const out = (await webFetchTool.handler(
      { url: 'https://example.com/api.json', format: 'text', method: 'GET' },
      baseCtx(),
    )) as string;
    expect(out).toContain('{"ok":true}');
  });

  it('truncates to maxBytes', async () => {
    const huge = 'x'.repeat(2_000_000);
    globalThis.fetch = vi.fn(async () =>
      mkResponse(huge, { 'content-type': 'text/plain' }),
    ) as never;

    const out = (await webFetchTool.handler(
      { url: 'https://example.com', format: 'raw', method: 'GET', maxBytes: 1024 },
      baseCtx(),
    )) as string;
    expect(out).toContain('[response truncated]');
    expect(out.length).toBeLessThan(20_000);
  });

  it('follows redirects', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === 'https://example.com/a') {
        return mkResponse('', { location: 'https://example.com/b' }, 302);
      }
      return mkResponse('arrived', { 'content-type': 'text/plain' });
    }) as never;

    const out = (await webFetchTool.handler(
      { url: 'https://example.com/a', format: 'raw', method: 'GET' },
      baseCtx(),
    )) as string;
    expect(out).toContain('arrived');
    expect(calls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });
});

function mkResponse(
  body: string,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, { status, headers });
}
