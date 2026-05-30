import { useState } from 'react';
import { Modal } from '@/lib/Modal';

export function RenameWorkspaceModal({
  desk,
  onSubmit,
  onClose,
}: {
  readonly desk: { id: string; name: string; cwd: string };
  readonly onSubmit: (name: string) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState(desk.name);
  const [busy, setBusy] = useState(false);
  const canSubmit = name.trim().length > 0 && name.trim() !== desk.name;
  return (
    <Modal title="Rename workspace" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setBusy(true);
          await onSubmit(name.trim());
          setBusy(false);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              padding: '9px 12px',
              fontSize: 14,
              color: 'var(--color-text)',
              background: '#fff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
            }}
          />
        </label>
        <div
          className="mono"
          style={{
            fontSize: 11.5,
            color: 'var(--color-text-dim)',
            wordBreak: 'break-all',
          }}
        >
          {desk.cwd}
        </div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
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
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || busy}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              color: '#fff',
              background: 'var(--color-primary-strong)',
              borderRadius: 10,
              fontWeight: 600,
              opacity: canSubmit && !busy ? 1 : 0.5,
            }}
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
