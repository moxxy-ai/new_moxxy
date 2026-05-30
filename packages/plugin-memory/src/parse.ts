// Minimal MD+frontmatter parser. Local copy so the plugin stays leaf-only (no
// @moxxy/core dependency). Mirrors packages/core/src/skills/parse.ts.

const FRONTMATTER_FENCE = '---';
const OPENING_FENCE_LF = FRONTMATTER_FENCE + '\n';
const OPENING_FENCE_CRLF = FRONTMATTER_FENCE + '\r\n';

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMdFile(content: string): ParsedFile {
  if (!content.startsWith(OPENING_FENCE_LF) && !content.startsWith(OPENING_FENCE_CRLF)) {
    return { frontmatter: {}, body: content };
  }
  const fenceLen = content.startsWith(OPENING_FENCE_CRLF) ? OPENING_FENCE_CRLF.length : OPENING_FENCE_LF.length;
  const rest = content.slice(fenceLen);
  const m = /\r?\n---(?:\r?\n|$)/.exec(rest);
  if (!m) return { frontmatter: {}, body: content };
  return {
    frontmatter: parseFrontmatter(rest.slice(0, m.index)),
    body: rest.slice(m.index + m[0].length),
  };
}

export function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    if (raw === '' && i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1] ?? '')) {
      const items: unknown[] = [];
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1] ?? '')) {
        i += 1;
        items.push(parseScalar((lines[i] ?? '').replace(/^\s*-\s*/, '').trim()));
      }
      result[key] = items;
      continue;
    }
    result[key] = parseScalar(raw);
  }
  return result;
}

function parseScalar(v: string): unknown {
  if (!v) return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => stripQuotes(s.trim()));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return stripQuotes(v);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

export function renderFrontmatter(frontmatter: Record<string, unknown>): string {
  const out: string[] = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === undefined || v === null) continue;
    out.push(`${k}: ${renderValue(v)}`);
  }
  out.push('---');
  return out.join('\n');
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    return needsQuoting(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
  }
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return `[${v.map((x) => renderValue(x)).join(', ')}]`;
  }
  return JSON.stringify(v);
}

function needsQuoting(s: string): boolean {
  return s.includes(':') || s.includes('#') || s.includes('"') || s.startsWith(' ') || s.endsWith(' ');
}
