/**
 * The first-run welcome step — the Moxxy avatar + intro copy + a single
 * "Let's go" CTA that advances the flow. First-run only (see
 * ONBOARDING_STEPS); no gating logic of its own.
 */

import { Icon } from '@/lib/Icon';
import { PrimaryButton } from '../chrome';

export function WelcomeStep({ onNext }: { readonly onNext: () => void }): JSX.Element {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 18 }}
    >
      <img
        src="/avatar.gif"
        alt=""
        aria-hidden
        className="moxxy-avatar-loader"
        style={{ width: 220, height: 'auto', imageRendering: 'pixelated' }}
      />
      <div>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
          Hi, I&rsquo;m <span style={{ color: 'var(--color-primary-strong)' }}>Moxxy</span>.
        </h2>
        <p
          style={{
            margin: '8px 0 0',
            color: 'var(--color-text-muted)',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          Your personal AI workspaces, running on your machine. Bring your own
          provider keys, pick a model, and I&rsquo;ll do the rest.
        </p>
      </div>
      <PrimaryButton onClick={onNext}>
        Let&rsquo;s go <Icon name="chevron-right" size={14} />
      </PrimaryButton>
    </div>
  );
}
