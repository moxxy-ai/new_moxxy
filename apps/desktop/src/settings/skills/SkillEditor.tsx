/**
 * Skill editor — the right-hand "writing surface" for a single skill:
 *
 *   ┌── header (name + Unsaved pill + Preview/Edit toggle + delete + save) ──┐
 *   │                                                                        │
 *   │  body  (markdown preview OR a monospace textarea)                      │
 *   │                                                                        │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Pure view — all state (the loaded body, dirty flag, mode, save/delete
 * intents) lives in the parent SkillsView; this renders it and reports edits
 * back via callbacks.
 */

import { Icon } from '@/lib/Icon';
import { MarkdownBody } from '@/chat/MarkdownBody';
import { LoadingHero } from './heroes';

export function SkillEditor({
  name,
  body,
  onBodyChange,
  mode,
  onModeChange,
  dirty,
  loading,
  saving,
  onSave,
  onDelete,
}: {
  readonly name: string;
  readonly body: string;
  readonly onBodyChange: (next: string) => void;
  readonly mode: 'edit' | 'preview';
  readonly onModeChange: (next: 'edit' | 'preview') => void;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  return (
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
        <span
          className="mono"
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: 'var(--color-text)',
          }}
        >
          {name}
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
        <SegmentedToggle value={mode} onChange={onModeChange} />
        <button
          type="button"
          className="btn-icon"
          aria-label="Delete skill"
          onClick={onDelete}
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
          onClick={onSave}
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
      </header>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loading && <LoadingHero />}
        {!loading && mode === 'preview' && (
          <div style={{ padding: 20, overflowY: 'auto', height: '100%' }}>
            <MarkdownBody text={body} />
          </div>
        )}
        {!loading && mode === 'edit' && (
          <textarea
            value={body}
            onChange={(e) => onBodyChange(e.target.value)}
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
