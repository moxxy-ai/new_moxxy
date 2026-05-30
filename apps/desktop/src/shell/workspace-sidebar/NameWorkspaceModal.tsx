import { useState } from 'react';
import { Modal } from '@/lib/Modal';

/**
 * Naming dialog shown after the user picks a folder for a new workspace.
 * Pre-fills the field with the folder's basename and echoes the full
 * path below so the user can confirm what they picked before creating.
 */
export function NameWorkspaceModal({
  defaultName,
  folder,
  onSubmit,
  onCancel,
}: {
  readonly defaultName: string;
  readonly folder: string;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState(defaultName);
  const canSubmit = name.trim().length > 0;
  return (
    <Modal title="New workspace" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(name);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
          }}
        >
          Name
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
            padding: '8px 10px',
            background: '#f7f8fc',
            border: '1px solid var(--color-card-border)',
            borderRadius: 8,
          }}
        >
          {folder}
        </div>
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
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              color: '#fff',
              background: 'var(--color-primary-strong)',
              borderRadius: 10,
              fontWeight: 600,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            Create
          </button>
        </footer>
      </form>
    </Modal>
  );
}
