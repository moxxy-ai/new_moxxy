/**
 * Full-screen splash — shown until the first ConnectionSnapshot
 * arrives. Uses the moxxy avatar as a gentle floating loader so the
 * cold-start moment feels like the brand instead of a generic ring
 * spinner.
 */

import './styles.css';

export function Splash({
  message = 'Starting moxxy…',
}: {
  readonly message?: string;
}): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.25rem',
        // Match the chat surface bg so the cold-start splash feels
        // continuous with the app's first useful screen.
        background: 'rgb(252, 252, 255)',
        color: 'var(--color-text)',
      }}
    >
      <img
        src="/avatar.gif"
        alt=""
        aria-hidden="true"
        className="moxxy-avatar-loader"
        width={160}
        height={160}
        style={{
          width: 160,
          height: 160,
        }}
      />
      <p
        className="mono"
        style={{
          margin: 0,
          fontSize: '0.85rem',
          color: 'var(--color-text-muted)',
          letterSpacing: '0.04em',
        }}
      >
        {message}
      </p>
    </div>
  );
}
