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
 */

import { useEffect, useState } from 'react';
import { toErrorMessage } from '@/lib/errors';
import { useActiveWorkspaceId } from '@/lib/useConnection';
import { chatStore } from '@/lib/chatStore';
import { api } from '@/lib/api';
import { Icon } from '@/lib/Icon';
import { Modal, ConfirmModal } from '@/lib/Modal';
import { MarkdownBody } from '@/chat/MarkdownBody';
import type { useSettings } from '@/lib/useSettings';
import type { MoxxyEvent } from '@moxxy/sdk';

const SKILL_PROMPT_TEMPLATE = (description: string): string => `You are
generating a new \`moxxy\` skill file. Skills are short Markdown docs
the agent loads to gain a capability. They open with YAML frontmatter
of \`name:\` (kebab-case slug), \`description:\` (single sentence about
when to use it), and then a body describing inputs, steps, and
constraints in plain prose.

Output ONLY the raw skill markdown (no commentary, no surrounding
code fence). Aim for a focused, single-purpose skill.

USER DESCRIPTION:
${description}`.trim();

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

      <article
        style={{
          // Match the chat surface background so the skill body reads as
          // the same "writing surface" as a conversation.
          background: 'rgb(252, 252, 255)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 12,
          overflow: 'hidden',
          minHeight: 460,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid var(--color-card-border)',
          }}
        >
          {active ? (
            <>
              <span
                className="mono"
                style={{
                  fontWeight: 700,
                  fontSize: 13,
                  color: 'var(--color-text)',
                }}
              >
                {active}
              </span>
              {dirty && (
                <span
                  style={{
                    fontSize: 10.5,
                    padding: '2px 6px',
                    borderRadius: 999,
                    background: 'var(--color-primary-soft)',
                    color: 'var(--color-primary-strong)',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Unsaved
                </span>
              )}
              <span style={{ flex: 1 }} />
              <SegmentedToggle value={mode} onChange={setMode} />
              <button
                type="button"
                className="btn-icon"
                aria-label="Delete skill"
                onClick={() => setDeletePending(active)}
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
                <Icon name="x" size={14} />
              </button>
              <button
                type="button"
                className="btn-cta"
                onClick={() => void onSave()}
                disabled={!dirty || saving}
                style={{
                  padding: '6px 14px',
                  background: dirty ? 'var(--grad-cta)' : '#e5e7eb',
                  color: dirty ? '#fff' : 'var(--color-text-dim)',
                  fontWeight: 600,
                  borderRadius: 9,
                  fontSize: 13,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Icon name="check" size={14} />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--color-text-dim)' }}>
              Pick a skill on the left, or generate a new one with AI.
            </span>
          )}
        </header>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {loading && active && <LoadingHero />}
          {!loading && active && mode === 'preview' && (
            <div style={{ padding: 20, overflowY: 'auto', height: '100%' }}>
              <MarkdownBody text={body} />
            </div>
          )}
          {!loading && active && mode === 'edit' && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                height: '100%',
                padding: '16px 18px',
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: 'var(--font-mono)',
                background: 'transparent',
                color: 'var(--color-text)',
                border: 'none',
                outline: 'none',
                resize: 'none',
              }}
            />
          )}
        </div>
      </article>
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

/**
 * Browse view — a readable, full-width gallery of skill cards (icon + name +
 * description) with the create / generate actions in the header. Picking a
 * card opens the editor; the gallery is hidden while editing.
 */
function SkillGallery({
  skills,
  onPick,
  onCreate,
  onGenerate,
}: {
  readonly skills: ReturnType<typeof useSettings>['skills'];
  readonly onPick: (name: string) => void;
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Skills</h2>
        <span
          style={{
            minWidth: 22,
            textAlign: 'center',
            padding: '1px 7px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--color-text-muted)',
            background: 'rgba(148, 163, 184, 0.16)',
          }}
        >
          {skills.length}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-chip"
          onClick={onGenerate}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '8px 13px',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 10,
            background: '#fff',
          }}
        >
          <Icon name="spark" size={14} />
          Generate with AI
        </button>
        <button
          type="button"
          className="btn-cta"
          onClick={onCreate}
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
          <Icon name="plus" size={14} />
          New skill
        </button>
      </div>

      {skills.length === 0 ? (
        <EmptyHero onCreate={onCreate} onGenerate={onGenerate} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {skills.map((skill) => (
            <button
              key={skill.name}
              type="button"
              className="skill-card"
              onClick={() => onPick(skill.name)}
              style={{
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: 16,
                minHeight: 104,
                background: 'var(--color-card-bg)',
                border: '1px solid var(--color-card-border)',
                borderRadius: 14,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    borderRadius: 9,
                    background: 'var(--color-primary-soft)',
                    color: 'var(--color-primary-strong)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="spark" size={16} />
                </span>
                <span
                  className="mono"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: 'var(--color-text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {skill.name.replace(/\.md$/, '')}
                </span>
                <Icon
                  name="chevron-right"
                  size={15}
                  style={{ color: 'var(--color-text-dim)', flexShrink: 0 }}
                />
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: skill.description ? 'var(--color-text-muted)' : 'var(--color-text-dim)',
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {skill.description ?? 'No description.'}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentedToggle({
  value,
  onChange,
}: {
  readonly value: 'edit' | 'preview';
  readonly onChange: (next: 'edit' | 'preview') => void;
}): JSX.Element {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        background: '#f4f5fb',
        border: '1px solid var(--color-card-border)',
        borderRadius: 9,
        padding: 2,
      }}
    >
      {(['preview', 'edit'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={value === m}
          onClick={() => onChange(m)}
          style={{
            padding: '4px 10px',
            fontSize: 11.5,
            fontWeight: 700,
            borderRadius: 7,
            color: value === m ? 'var(--color-text)' : 'var(--color-text-dim)',
            background: value === m ? '#fff' : 'transparent',
            boxShadow: value === m ? '0 1px 2px rgba(15,23,42,0.06)' : 'none',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function EmptyHero({
  onCreate,
  onGenerate,
}: {
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div>
        <img
          src="/avatar.gif"
          alt=""
          aria-hidden
          style={{ width: 140, height: 'auto', imageRendering: 'pixelated', marginBottom: 14 }}
        />
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Compose a new skill</h3>
        <p style={{ margin: '6px 0 16px', color: 'var(--color-text-dim)', fontSize: 13 }}>
          Skills are Markdown files I'll read on demand to learn how to do something specific.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            type="button"
            onClick={onCreate}
            className="btn-cta"
            style={{
              padding: '10px 16px',
              background: 'var(--grad-cta)',
              color: '#fff',
              fontWeight: 600,
              borderRadius: 10,
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="plus" size={14} />
            Blank skill
          </button>
          <button
            type="button"
            onClick={onGenerate}
            className="btn-outline"
            style={{
              padding: '10px 16px',
              border: '1px solid var(--color-card-border)',
              background: '#fff',
              color: 'var(--color-text-muted)',
              fontWeight: 600,
              borderRadius: 10,
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="spark" size={14} />
            Generate with AI
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadingHero(): JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        color: 'var(--color-text-dim)',
        fontSize: 13,
        gap: 10,
      }}
    >
      <img
        src="/avatar.gif"
        alt=""
        aria-hidden
        className="moxxy-avatar-loader moxxy-avatar-loader--sm"
        style={{ width: 64, height: 'auto', imageRendering: 'pixelated' }}
      />
      Loading…
    </div>
  );
}

function CreateSkillModal({
  initial,
  existing,
  onCancel,
  onSubmit,
}: {
  readonly initial?: string;
  readonly existing: ReadonlyArray<string>;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string, content: string) => Promise<void>;
}): JSX.Element {
  const suggestedFromBody = (text: string | undefined): string => {
    if (!text) return 'untitled-skill.md';
    const match = text.match(/name:\s*([\w-]+)/i);
    return match ? `${match[1]}.md` : 'new-skill.md';
  };
  const [name, setName] = useState(suggestedFromBody(initial));
  const [body, setBody] = useState(
    initial ??
      `---
name: my-skill
description: One-sentence summary of when to use this.
---

# My skill

Describe the inputs, the steps to take, and any constraints here.
`,
  );
  const [busy, setBusy] = useState(false);
  const isMd = name.endsWith('.md');
  const safeName = isMd && !/[/]/.test(name) && !name.startsWith('.');
  const collision = existing.includes(name);
  const canSubmit = safeName && !collision && body.trim().length > 0 && !busy;

  return (
    <Modal title="New skill" onClose={onCancel} width={640}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setBusy(true);
          await onSubmit(name.trim(), body);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            Filename
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-skill.md"
            spellCheck={false}
            style={{
              padding: '9px 12px',
              fontSize: 14,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text)',
              background: '#f7f8fc',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
            }}
          />
          {!isMd && (
            <span style={{ fontSize: 11.5, color: 'var(--color-red)' }}>
              Filename must end in .md
            </span>
          )}
          {collision && (
            <span style={{ fontSize: 11.5, color: 'var(--color-red)' }}>
              A skill with this name already exists.
            </span>
          )}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            Markdown body
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            style={{
              minHeight: 260,
              padding: '12px 14px',
              fontSize: 12.5,
              lineHeight: 1.55,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text)',
              background: '#fbfcff',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </label>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            className="btn-outline"
            style={{
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              background: '#fff',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-cta"
            style={{
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--grad-cta)',
              borderRadius: 10,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            {busy ? 'Saving…' : 'Create skill'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function GenerateSkillModal({
  onCancel,
  onUseGenerated,
}: {
  readonly onCancel: () => void;
  readonly onUseGenerated: (content: string) => void;
}): JSX.Element {
  const workspaceId = useActiveWorkspaceId();
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [generated, setGenerated] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [turnId, setTurnId] = useState<string | null>(null);

  // The generation runs as a real runner turn (the only path to the model
  // from this thin client), but the turn is HIDDEN from the transcript via
  // chatStore.hideTurn — so it never pollutes the chat. We mirror the
  // assistant chunks into local state for the in-modal preview.
  useEffect(() => {
    if (!turnId) return;
    const offEvent = api().subscribe(
      'runner.event',
      ({ event: ev }: { workspaceId: string; event: MoxxyEvent }) => {
        if (ev.turnId !== turnId) return;
        if (ev.type === 'assistant_chunk') {
          setGenerated((cur) => cur + ev.delta);
        } else if (ev.type === 'assistant_message') {
          setGenerated(ev.content);
        }
      },
    );
    const offDone = api().subscribe(
      'runner.turn.complete',
      ({ turnId: id, error: err }: { workspaceId: string; turnId: string; error: string | null }) => {
        if (id !== turnId) return;
        chatStore.unhideTurn(id);
        if (err) {
          setPhase('error');
          setError(err);
        } else {
          setPhase('done');
        }
      },
    );
    return () => {
      offEvent();
      offDone();
      chatStore.unhideTurn(turnId);
    };
  }, [turnId]);

  const onGenerate = async (): Promise<void> => {
    if (!workspaceId || !description.trim()) return;
    setPhase('streaming');
    setGenerated('');
    setError(null);
    try {
      const { turnId: id } = await api().invoke('session.runTurn', {
        workspaceId,
        prompt: SKILL_PROMPT_TEMPLATE(description.trim()),
      });
      // Hide BEFORE we start reading: the runner echoes a user_prompt + the
      // assistant output for this turn, and none of it should reach the
      // transcript. We deliberately do NOT dispatch send_started either, so
      // the chat never shows a phantom "sending" turn.
      chatStore.hideTurn(id);
      setTurnId(id);
    } catch (e) {
      setPhase('error');
      setError(toErrorMessage(e));
    }
  };

  return (
    <Modal title="Generate skill with AI" onClose={onCancel} width={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            Describe the skill
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A skill that summarises long URLs by fetching them, extracting the headline and key bullets, and citing each source link."
            disabled={phase === 'streaming'}
            style={{
              minHeight: 110,
              padding: '12px 14px',
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--color-text)',
              background: '#f7f8fc',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
        </label>
        <span style={{ fontSize: 11.5, color: 'var(--color-text-dim)' }}>
          {workspaceId
            ? 'Generated privately — it stays here in the editor and never shows in the chat.'
            : 'No active workspace — open one before generating.'}
        </span>
        {(phase === 'streaming' || phase === 'done' || phase === 'error') && (
          <section
            style={{
              border: '1px solid var(--color-card-border)',
              borderRadius: 12,
              overflow: 'hidden',
              background: '#fff',
            }}
          >
            <header
              style={{
                padding: '8px 12px',
                background: '#f4f5fb',
                borderBottom: '1px solid var(--color-card-border)',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--color-text-dim)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Preview {phase === 'streaming' && '· streaming'}
            </header>
            <div
              style={{
                maxHeight: 360,
                overflowY: 'auto',
                padding: 16,
              }}
            >
              {generated ? (
                <MarkdownBody text={generated} streaming={phase === 'streaming'} />
              ) : (
                <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-dim)' }}>
                  Waiting for the first chunk…
                </p>
              )}
            </div>
          </section>
        )}
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--color-red)' }}>
            {error}
          </p>
        )}
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            className="btn-outline"
            style={{
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-card-border)',
              borderRadius: 10,
              background: '#fff',
            }}
          >
            Cancel
          </button>
          {(() => {
            // One primary action that morphs by phase: Generate → Generating…
            // → Use this skill (shown in the same spot once a draft exists).
            const ready = phase === 'done' && generated.trim().length > 0;
            const canGenerate = !!workspaceId && description.trim().length > 0;
            const disabled = phase === 'streaming' || (!ready && !canGenerate);
            return (
              <button
                type="button"
                onClick={ready ? () => onUseGenerated(generated) : () => void onGenerate()}
                disabled={disabled}
                className="btn-cta"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#fff',
                  background: 'var(--grad-cta)',
                  borderRadius: 10,
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <Icon name={ready ? 'check' : 'spark'} size={14} />
                {phase === 'streaming'
                  ? 'Generating…'
                  : ready
                    ? 'Use this skill'
                    : 'Generate'}
              </button>
            );
          })()}
        </footer>
      </div>
    </Modal>
  );
}
