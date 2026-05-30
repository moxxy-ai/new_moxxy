export function ErrorToast({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        padding: '8px 14px',
        background: 'var(--color-red)',
        color: '#fff',
        borderRadius: 10,
        fontSize: 13,
        boxShadow: '0 14px 28px -16px rgba(239, 68, 68, 0.6)',
      }}
    >
      {text}
    </div>
  );
}
