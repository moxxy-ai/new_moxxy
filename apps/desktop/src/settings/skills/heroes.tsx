/**
 * Empty / loading states for the Skills tab. EmptyHero greets a user with no
 * skills yet (avatar + the two create paths); LoadingHero is the spinner shown
 * inside the editor while a skill's body streams in from disk.
 */

import { Icon } from '@/lib/Icon';

export function EmptyHero({
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

export function LoadingHero(): JSX.Element {
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
