import { markdownToTelegramHtml } from '../format.js';
import type { RenderedFrame } from '../render.js';

/**
 * Compose one Telegram message string from the renderer's structured
 * snapshot. The activity block is pre-formatted HTML (the renderer
 * emits `<blockquote>`, `<code>`, `<b>`, `<i>` directly so it can
 * style tool calls without going through the markdown converter). The
 * assistant body is plain Markdown from the model — convert it through
 * `markdownToTelegramHtml` so `**bold**`, `` `code` ``, ```code blocks```,
 * `[links](…)`, and list bullets render natively in Telegram.
 *
 * The error line is also pre-formatted HTML (small, controlled).
 */
export function composeFrame(snap: RenderedFrame): string {
  const parts: string[] = [];
  if (snap.activityHtml) parts.push(snap.activityHtml);
  if (snap.body) parts.push(markdownToTelegramHtml(snap.body));
  if (snap.errorHtml) parts.push(snap.errorHtml);
  return parts.join('\n\n');
}

/** Strip every HTML tag for plain-text fallback when Telegram rejects
 *  our parse_mode=HTML payload (rare — usually a malformed entity in
 *  user-supplied content). Keeps text content intact. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
