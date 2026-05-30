import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly error: Error | null;
  readonly componentStack: string | null;
}

/**
 * Top-level renderer error boundary. Without one, any uncaught error during
 * render makes React 18 unmount the whole tree — leaving a blank white window
 * with nothing on screen and (in a packaged build) nothing the user can see.
 *
 * This renders the error inline instead, with a Reload button, and logs it to
 * the console (which `electron/main` forwards to its log file). Styled with
 * plain inline styles so it works even if the app stylesheet failed to load.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // A blank screen with nothing logged is the worst failure mode — make
    // it loud. electron/main mirrors renderer console errors to its log.
    console.error('[moxxy-desktop] renderer crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: '48px 40px',
          overflow: 'auto',
          background: 'rgb(252, 252, 255)',
          color: '#0f172a',
          fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>MoxxyAI Workspaces hit an error</div>
        <div style={{ fontSize: 14, color: '#475569' }}>
          The app failed to render. You can reload, or report this with the details below.
        </div>
        <pre
          style={{
            margin: 0,
            padding: 16,
            borderRadius: 10,
            background: '#0f172a',
            color: '#e2e8f0',
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '50vh',
            overflow: 'auto',
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
          {componentStack ? `\n\nComponent stack:${componentStack}` : ''}
        </pre>
        <div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              height: 40,
              padding: '0 20px',
              borderRadius: 10,
              border: 'none',
              background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
