/**
 * Shared style tokens + helpers for the transcript block components.
 * Kept tiny and dependency-free so every block file (tool / subagent /
 * assistant) can pull the same expanded-body `<pre>` look.
 */

export const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  background: '#f6f7fc',
  border: '1px solid var(--color-card-border)',
  borderRadius: 6,
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 280,
  overflow: 'auto',
};

/** Pretty 2-space JSON for the expanded tool body (distinct from
 *  chat-model's single-line `stringify`, which feeds summaries). */
export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
