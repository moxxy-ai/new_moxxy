/**
 * Render assistant text as Markdown. We restrict to safe blocks
 * (no raw HTML) and tighten the styles so paragraphs/lists feel
 * native to the chat surface rather than document-y.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const components: Components = {
  p: (p) => (
    <p style={{ margin: '0 0 0.55em', lineHeight: 1.7 }} {...p} />
  ),
  ul: (p) => (
    <ul style={{ margin: '0 0 0.55em', paddingLeft: 22, lineHeight: 1.7 }} {...p} />
  ),
  ol: (p) => (
    <ol style={{ margin: '0 0 0.55em', paddingLeft: 22, lineHeight: 1.7 }} {...p} />
  ),
  li: (p) => <li style={{ margin: '0.1em 0' }} {...p} />,
  h1: (p) => (
    <h1 style={{ margin: '0.4em 0 0.4em', fontSize: 18, fontWeight: 700 }} {...p} />
  ),
  h2: (p) => (
    <h2 style={{ margin: '0.4em 0 0.4em', fontSize: 16, fontWeight: 700 }} {...p} />
  ),
  h3: (p) => (
    <h3 style={{ margin: '0.4em 0 0.4em', fontSize: 14.5, fontWeight: 700 }} {...p} />
  ),
  a: (p) => (
    <a
      {...p}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: 'var(--color-primary-strong)', textDecoration: 'underline' }}
    />
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = /language-/.test(className ?? '');
    if (!isBlock) {
      return (
        <code
          {...rest}
          className={className}
          style={{
            background: '#f1f3fb',
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: '0.92em',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre: (p) => (
    <pre
      {...p}
      style={{
        margin: '0 0 0.55em',
        padding: '10px 12px',
        background: '#f4f5fa',
        border: '1px solid var(--color-card-border)',
        borderRadius: 8,
        fontSize: 12.5,
        fontFamily: 'var(--font-mono)',
        overflowX: 'auto',
        lineHeight: 1.55,
      }}
    />
  ),
  blockquote: (p) => (
    <blockquote
      {...p}
      style={{
        margin: '0 0 0.55em',
        padding: '4px 12px',
        borderLeft: '3px solid var(--color-primary)',
        color: 'var(--color-text-muted)',
      }}
    />
  ),
  hr: () => (
    <hr
      style={{
        border: 'none',
        borderTop: '1px solid var(--color-card-border)',
        margin: '0.6em 0',
      }}
    />
  ),
  table: (p) => (
    <table
      {...p}
      style={{
        borderCollapse: 'collapse',
        margin: '0 0 0.55em',
        fontSize: 13,
      }}
    />
  ),
  th: (p) => (
    <th
      {...p}
      style={{
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '1px solid var(--color-card-border-strong)',
        fontWeight: 600,
      }}
    />
  ),
  td: (p) => (
    <td
      {...p}
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid var(--color-card-border)',
      }}
    />
  ),
};

export function MarkdownBody({
  text,
  streaming = false,
}: {
  readonly text: string;
  /** When true, attaches a blinking cursor via CSS ::after to the last
   *  rendered block so the tail of the streaming text doesn't jump to
   *  a new line. */
  readonly streaming?: boolean;
}): JSX.Element {
  return (
    <div
      className={streaming ? 'markdown-body streaming' : 'markdown-body'}
      style={{
        fontSize: 14.5,
        lineHeight: 1.7,
        color: 'var(--color-text)',
        wordBreak: 'break-word',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
