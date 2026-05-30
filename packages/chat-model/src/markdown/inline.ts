import type { InlineTok } from './types.js';

/**
 * Match `inline code`, **bold**, *italic*, [label](url) in priority order
 * (longest-match-wins via single combined regex). Everything between
 * matches becomes a plain text token. Framework-neutral — the Ink/DOM
 * renderers map the token stream to their own elements.
 */
export function tokenizeInline(input: string): InlineTok[] {
  const re = /(`[^`\n]+`)|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  const out: InlineTok[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIdx) {
      out.push({ kind: 'text', value: input.slice(lastIdx, match.index) });
    }
    if (match[1]) {
      out.push({ kind: 'code', value: match[1].slice(1, -1) });
    } else if (match[2]) {
      out.push({ kind: 'bold', value: match[3]! });
    } else if (match[4]) {
      out.push({ kind: 'italic', value: match[5]! });
    } else if (match[6]) {
      out.push({ kind: 'link', label: match[7]!, url: match[8]! });
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < input.length) {
    out.push({ kind: 'text', value: input.slice(lastIdx) });
  }
  return out;
}

/** Drop inline markdown markup, leaving the bare text. */
export function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
