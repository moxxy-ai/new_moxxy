/**
 * The first-workspace step — pick a folder, name the workspace, and
 * create + activate it. Surfaces any existing workspaces and lets the
 * user skip. First-run only.
 */

import { useState } from 'react';
import { useDesks } from '@/lib/useDesks';
import { Icon } from '@/lib/Icon';
import { StepCard, Nav, PrimaryButton, SuccessRow, inputStyle, pickerBtnStyle } from '../chrome';

export function WorkspaceStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  const desks = useDesks();
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState('My workspace');
  const [creating, setCreating] = useState(false);

  const onPickFolder = async (): Promise<void> => {
    const f = await desks.pickFolder();
    if (f) {
      setFolder(f);
      setName(f.split('/').filter(Boolean).pop() ?? 'My workspace');
    }
  };

  const onCreate = async (): Promise<void> => {
    if (!folder || !name.trim()) return;
    setCreating(true);
    try {
      const desk = await desks.create(name.trim(), folder);
      if (desk) await desks.setActive(desk.id);
      onNext();
    } finally {
      setCreating(false);
    }
  };

  const hasAny = desks.desks.length > 0;

  return (
    <StepCard
      title="Pick a workspace"
      sub="A workspace is a folder I'll operate in. You can add more later."
    >
      {hasAny && (
        <SuccessRow
          text={`You already have ${desks.desks.length} workspace${desks.desks.length === 1 ? '' : 's'}.`}
        />
      )}
      <div
        style={{
          padding: '16px 18px',
          background: 'var(--color-card-bg)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <button type="button" onClick={() => void onPickFolder()} style={pickerBtnStyle}>
          <Icon name="workspace" size={16} />
          {folder ? folder : 'Choose a folder…'}
        </button>
        {folder && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </label>
        )}
        <PrimaryButton
          onClick={() => void onCreate()}
          disabled={!folder || !name.trim() || creating}
        >
          {creating ? 'Creating…' : 'Create workspace'}
        </PrimaryButton>
      </div>
      <Nav onBack={onBack} onNext={onNext} nextLabel="Skip for now" />
    </StepCard>
  );
}
