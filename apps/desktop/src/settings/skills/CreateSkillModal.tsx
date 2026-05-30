/**
 * "New skill" modal — a filename field + a Markdown body editor with light
 * client-side validation (must end in `.md`, no path separators, no collision
 * with an existing skill). When opened from the Generate flow it seeds the
 * body with the AI draft and derives a suggested filename from its frontmatter.
 */

import { useState } from 'react';
import { Modal } from '@/lib/Modal';

export function CreateSkillModal({
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
