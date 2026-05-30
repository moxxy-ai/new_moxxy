/** Initial-load spinner — shown while the first window of persisted
 *  transcript is read from disk, before EmptyState or the Transcript. */
export function ChatLoading(): JSX.Element {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            border: '2.5px solid var(--color-card-border)',
            borderTopColor: 'var(--color-primary)',
            animation: 'moxxy-spin 0.8s linear infinite',
          }}
        />
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-dim)' }}>
          Loading conversation…
        </p>
      </div>
    </div>
  );
}
