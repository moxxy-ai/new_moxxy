/**
 * Browse view — a readable, full-width gallery of skill cards (icon + name +
 * description) with the create / generate actions in the header. Picking a
 * card opens the editor; the gallery is hidden while editing.
 */

import { useState } from 'react';
import { Icon } from '@/lib/Icon';
import type { useSettings } from '@/lib/useSettings';
import { TabHeader } from '../TabHeader';
import { EmptyHero } from './heroes';

export function SkillGallery({
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
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? skills.filter(
        (sk) =>
          sk.name.toLowerCase().includes(q) || (sk.description?.toLowerCase().includes(q) ?? false),
      )
    : skills;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <TabHeader
        title="Skills"
        count={skills.length}
        description="Reusable instructions the agent loads when your message matches a skill's triggers. Create one, or generate it with AI."
        actions={
          <>
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
          </>
        }
      />

      {skills.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '9px 12px',
            background: '#fff',
            border: '1px solid var(--color-card-border)',
            borderRadius: 10,
          }}
        >
          <Icon name="search" size={15} style={{ color: 'var(--color-text-dim)', flexShrink: 0 }} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 13,
              color: 'var(--color-text)',
            }}
          />
        </div>
      )}

      {skills.length === 0 ? (
        <EmptyHero onCreate={onCreate} onGenerate={onGenerate} />
      ) : shown.length === 0 ? (
        <p style={{ margin: 0, padding: '24px 4px', fontSize: 13, color: 'var(--color-text-dim)' }}>
          No skills match “{query}”.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {shown.map((skill) => (
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
                minWidth: 0,
                maxWidth: '100%',
                overflow: 'hidden',
                minHeight: 104,
                background: 'var(--color-card-bg)',
                border: '1px solid var(--color-card-border)',
                borderRadius: 14,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  minWidth: 0,
                  width: '100%',
                  overflow: 'hidden',
                }}
              >
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
