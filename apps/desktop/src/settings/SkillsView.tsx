/**
 * Skills tab — redesigned. Three zones:
 *
 *   ┌──────────┬────────────────────────────────────────────────┐
 *   │ list     │ editor                                         │
 *   │          │  ┌── header (name + Preview/Edit + actions) ──┐│
 *   │ + New    │  │                                            ││
 *   │ ✨ Gen   │  │  body  (markdown preview OR textarea)      ││
 *   │          │  │                                            ││
 *   └──────────┴────────────────────────────────────────────────┘
 *
 * Generate-with-AI flow opens a modal that runs a turn against the
 * active workspace's session with a skill-shaped prompt template,
 * streams the assistant's output into a preview, and persists on
 * confirm. The generated content is dropped into the editor so the
 * user can tweak before committing.
 *
 * This is the thin container: it owns the editor state (active skill,
 * loaded body, dirty/save flags, modal intents) and wires the gallery,
 * editor, and the create / generate / delete modals together.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@/lib/Icon';
import { ConfirmModal } from '@/lib/Modal';
import { SkillGallery } from './skills/SkillGallery';
import { SkillEditor } from './skills/SkillEditor';
import { CreateSkillModal } from './skills/CreateSkillModal';
import { GenerateSkillModal } from './skills/GenerateSkillModal';
import type { useSettings } from '@/lib/useSettings';

export function SkillsView({
  s,
}: {
  readonly s: ReturnType<typeof useSettings>;
}): JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [serverBody, setServerBody] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState<{ initial?: string } | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);

  useEffect(() => {
    if (!active) {
      setBody('');
      setServerBody('');
      return;
    }
    setLoading(true);
    void s.readSkill(active).then((b) => {
      setBody(b);
      setServerBody(b);
      setLoading(false);
    });
  }, [active, s]);

  const dirty = body !== serverBody;

  const onSave = async (): Promise<void> => {
    if (!active || !dirty) return;
    setSaving(true);
    await s.writeSkill(active, body);
    setServerBody(body);
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!active && (
        <SkillGallery
          skills={s.skills}
          onPick={setActive}
          onCreate={() => setCreateOpen({})}
          onGenerate={() => setGenerateOpen(true)}
        />
      )}
      {active && (
        <button
          type="button"
          className="btn-chip"
          onClick={() => setActive(null)}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 9,
            background: '#fff',
          }}
        >
          <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
          All skills
        </button>
      )}
      {active && (
        <SkillEditor
          name={active}
          body={body}
          onBodyChange={setBody}
          mode={mode}
          onModeChange={setMode}
          dirty={dirty}
          loading={loading}
          saving={saving}
          onSave={() => void onSave()}
          onDelete={() => setDeletePending(active)}
        />
      )}

      {createOpen !== null && (
        <CreateSkillModal
          initial={createOpen.initial}
          existing={s.skills.map((sk) => sk.name)}
          onCancel={() => setCreateOpen(null)}
          onSubmit={async (name, content) => {
            await s.writeSkill(name, content);
            setActive(name);
            setCreateOpen(null);
          }}
        />
      )}
      {generateOpen && (
        <GenerateSkillModal
          onCancel={() => setGenerateOpen(false)}
          onUseGenerated={(content) => {
            setGenerateOpen(false);
            setCreateOpen({ initial: content });
          }}
        />
      )}
      {deletePending && (
        <ConfirmModal
          title="Delete skill?"
          message={`Remove ${deletePending}? The file under ~/.moxxy/skills will be deleted.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeletePending(null)}
          onConfirm={async () => {
            await s.deleteSkill(deletePending);
            if (active === deletePending) setActive(null);
            setDeletePending(null);
          }}
        />
      )}
    </div>
  );
}
