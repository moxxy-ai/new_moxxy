/**
 * Minimal HTML → text / markdown extractors used by `web_fetch`. Not a
 * full DOM parser: regex-based, intentionally limited. For stricter
 * extraction use the markdown converter with a selector or upgrade to
 * browser_session.
 */

export interface ExtractOptions {
  selector?: string;
}

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

/**
 * Minimal HTML → plain text. Strips <script>, <style>, comments, and tags.
 * Collapses whitespace. Decodes the common HTML entities.
 */
export function htmlToPlainText(html: string, opts: ExtractOptions = {}): string {
  let body = sliceBySelector(html, opts.selector);
  body = body.replace(COMMENT_RE, '');
  body = body.replace(SCRIPT_RE, '');
  body = body.replace(STYLE_RE, '');
  body = body.replace(/<br\b[^>]*>/gi, '\n');
  body = body.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  body = body.replace(/<[^>]+>/g, '');
  body = decodeEntities(body);
  return collapseWhitespace(body);
}

/**
 * Minimal HTML → markdown. Maps headings, lists, links, code blocks, and
 * paragraphs. Falls through to plain-text rules for unknown structure.
 */
export function htmlToMarkdown(html: string, opts: ExtractOptions = {}): string {
  let body = sliceBySelector(html, opts.selector);
  body = body.replace(COMMENT_RE, '');
  body = body.replace(SCRIPT_RE, '');
  body = body.replace(STYLE_RE, '');

  // headings
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) =>
    `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n\n`,
  );

  // links: keep text + url
  body = body.replace(
    /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => `[${stripTags(inner).trim()}](${href})`,
  );

  // code
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) =>
    `\n\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n\n`,
  );
  body = body.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) =>
    `\`${stripTags(inner)}\``,
  );

  // lists
  body = body.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) =>
    `\n- ${stripTags(inner).trim()}`,
  );
  body = body.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');

  // line breaks
  body = body.replace(/<br\b[^>]*>/gi, '\n');
  body = body.replace(/<\/?p\b[^>]*>/gi, '\n\n');
  body = body.replace(/<[^>]+>/g, '');
  body = decodeEntities(body);
  return collapseWhitespace(body);
}

function sliceBySelector(html: string, selector?: string): string {
  if (!selector) return html;
  const slice = extractFirstTagBlock(html, selector);
  return slice ?? html;
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return s.replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => {
    if (m in map) return map[m as keyof typeof map]!;
    const numMatch = /^&#(\d+);$/.exec(m);
    if (numMatch) return String.fromCharCode(Number(numMatch[1]));
    return m;
  });
}

/**
 * Pull the first <tag>...</tag> block (or self-closing tag with id="x") whose
 * tag name OR id matches `selector`. Very limited — supports `tagName` and
 * `#id` only. For richer querying upgrade to browser_session.
 */
function extractFirstTagBlock(html: string, selector: string): string | null {
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    const re = new RegExp(
      `<([a-z][a-z0-9-]*)\\b[^>]*\\bid=["']${escapeReSelector(id)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      'i',
    );
    const match = re.exec(html);
    return match ? match[2]! : null;
  }
  const tag = selector.toLowerCase();
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(html);
  return match ? match[1]! : null;
}

function escapeReSelector(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
