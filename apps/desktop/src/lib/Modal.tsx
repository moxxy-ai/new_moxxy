/**
 * Tiny modal primitive — render-prop style. Replaces window.prompt /
 * window.confirm (both are no-ops or partly broken in Electron).
 *
 * Usage:
 *
 *   const [open, setOpen] = useState(false);
 *   {open && (
 *     <Modal onClose={() => setOpen(false)} title="…">
 *       <form>…</form>
 *     </Modal>
 *   )}
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface ModalProps {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly onClose: () => void;
  readonly width?: number;
}

export function Modal({
  title,
  children,
  onClose,
  width = 380,
}: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portal the modal to document.body so it never lives inside a
  // parent <form>. Nested forms in the same DOM subtree cause the
  // inner form's submit to bubble up to the outer one — that was
  // reloading the app when the CommandPalette stepper's Next button
  // was clicked inside the Composer's form.
  if (typeof document === 'undefined') return <></>;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width,
          maxWidth: '92vw',
          background: 'var(--color-card-bg)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 16,
          boxShadow: '0 30px 60px -20px rgba(15, 23, 42, 0.35)',
          padding: '18px 18px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <header
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              color: 'var(--color-text-dim)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  ) as JSX.Element;
}

interface ConfirmProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmProps): JSX.Element {
  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ margin: 0, fontSize: 13.5, color: 'var(--color-text-muted)', lineHeight: 1.55 }}>
        {message}
      </p>
      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '8px 14px',
            fontSize: 13,
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 10,
            background: '#fff',
            fontWeight: 600,
          }}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          autoFocus
          style={{
            padding: '8px 14px',
            fontSize: 13,
            color: '#fff',
            background: destructive ? 'var(--color-red)' : 'var(--color-primary-strong)',
            borderRadius: 10,
            fontWeight: 600,
          }}
        >
          {confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}
