/**
 * Vault tab — secrets stored by the moxxy CLI, shown as a grid of
 * password-manager-style credential cards (key glyph + name + masked value).
 * Names only ever surface here; values are encrypted at rest and never leave
 * the host. The "Add key" action reveals an inline form with light validation
 * that mirrors the IPC schema.
 */

import { useState } from 'react';
import { Icon } from '@/lib/Icon';
import { Section, Tile, Badge, EmptyState } from './settings-primitives';

export function VaultTab({
  vault,
  search,
  onAdd,
  onRemove,
}: {
  readonly vault: ReadonlyArray<{ name: string }>;
  readonly search?: React.ReactNode;
  readonly onAdd: (name: string, value: string) => Promise<void>;
  readonly onRemove: (name: string) => Promise<void>;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Vault"
      count={vault.length}
      description="Secrets stored by the moxxy CLI. Names only — values are encrypted at rest and never leave the host."
      search={search}
      actions={
        <button
          type="button"
          className="btn-cta"
          onClick={() => setAdding((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--grad-cta)',
            borderRadius: 10,
          }}
        >
          <Icon name={adding ? 'x' : 'plus'} size={14} />
          {adding ? 'Close' : 'Add key'}
        </button>
      }
    >
      {adding && (
        <AddKeyForm
          existing={vault.map((v) => v.name)}
          onCancel={() => setAdding(false)}
          onSubmit={async (name, value) => {
            await onAdd(name, value);
            setAdding(false);
          }}
        />
      )}
      {vault.length === 0 ? (
        <EmptyState icon="lock" text="The vault is empty." />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {vault.map((v) => (
            <VaultKeyCard key={v.name} name={v.name} onRemove={() => void onRemove(v.name)} />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Inline add-key form — name + secret value, with light validation that
 *  mirrors the IPC schema so the user gets immediate feedback. */
function AddKeyForm({
  existing,
  onSubmit,
  onCancel,
}: {
  readonly existing: ReadonlyArray<string>;
  readonly onSubmit: (name: string, value: string) => Promise<void>;
  readonly onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const validName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) && !trimmed.includes('..');
  const exists = existing.includes(trimmed);
  const canSubmit = validName && !exists && value.length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 14,
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="KEY_NAME (e.g. OPENAI_API_KEY)"
        className="mono"
        style={vaultInputStyle}
      />
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Secret value"
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        style={vaultInputStyle}
      />
      {name.trim() && !validName && (
        <span style={{ fontSize: 11.5, color: 'var(--color-red)' }}>
          Use letters, digits, and . _ / - (no spaces or “..”).
        </span>
      )}
      {exists && (
        <span style={{ fontSize: 11.5, color: 'var(--color-amber)' }}>
          A key named “{trimmed}” already exists — saving overwrites it.
        </span>
      )}
      {error && <span style={{ fontSize: 11.5, color: 'var(--color-red)' }}>{error}</span>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '7px 13px',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 9,
            background: '#fff',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-cta"
          onClick={() => void submit()}
          disabled={!(validName && value.length > 0) || busy}
          style={{
            padding: '7px 14px',
            fontSize: 12.5,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--grad-cta)',
            borderRadius: 9,
            opacity: validName && value.length > 0 && !busy ? 1 : 0.5,
          }}
        >
          {busy ? 'Saving…' : exists ? 'Overwrite' : 'Save key'}
        </button>
      </div>
    </div>
  );
}

const vaultInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  fontSize: 13,
  color: 'var(--color-text)',
  background: '#fff',
  border: '1px solid var(--color-card-border)',
  borderRadius: 9,
  outline: 'none',
};

/** Password-manager-style credential tile: a key glyph, the secret name,
 *  and a masked value — distinct from the provider/MCP row list so the
 *  vault reads as "stored secrets," not "things to toggle." */
function VaultKeyCard({
  name,
  onRemove,
}: {
  readonly name: string;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 15px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Tile bg="rgba(148, 163, 184, 0.16)" fg="var(--color-text-muted)">
          <Icon name="lock" size={15} />
        </Tile>
        <span
          className="mono"
          title={name}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </span>
        <button
          type="button"
          className="btn-icon"
          aria-label={`Delete ${name}`}
          title="Delete key"
          onClick={onRemove}
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            borderRadius: 7,
            color: 'var(--color-text-dim)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          aria-label="hidden value"
          style={{
            letterSpacing: '0.22em',
            fontSize: 15,
            lineHeight: 1,
            color: 'var(--color-text-dim)',
            userSelect: 'none',
          }}
        >
          ••••••••
        </span>
        <Badge>Encrypted</Badge>
      </div>
    </div>
  );
}
