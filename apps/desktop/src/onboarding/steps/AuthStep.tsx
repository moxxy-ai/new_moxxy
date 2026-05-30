/**
 * The sign-in step — embeds the branded Clerk <SignIn> when a publishable
 * key is configured, falls back to a local-only notice otherwise, and
 * persists the resolved Clerk identity into desktop prefs once signed in
 * (see SignedInPanel). First-run only; auto-satisfied when Clerk isn't
 * configured so keyless dev builds aren't blocked.
 */

import { useEffect } from 'react';
import { SignedIn, SignedOut, SignIn, useUser } from '@clerk/clerk-react';
import { Icon } from '@/lib/Icon';
import { usePrefs } from '@/lib/usePrefs';
import {
  CLERK_KEY,
  brandedClerkAppearance,
  StepCard,
  Nav,
  PrimaryButton,
  secondaryBtnStyle,
  authCardStyle,
} from '../chrome';

export function AuthStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  if (!CLERK_KEY) {
    return (
      <StepCard
        title="Sign in"
        sub="Auth provider isn't configured for this build. Continuing as a local user."
      >
        <div
          style={{
            padding: '16px 18px',
            background: 'var(--color-card-bg)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontSize: 13,
            color: 'var(--color-text-muted)',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--color-text)' }}>
            Local-only mode
          </div>
          <p style={{ margin: 0 }}>
            To enable Clerk-backed sign-in, set{' '}
            <code className="mono">VITE_CLERK_PUBLISHABLE_KEY</code> in the
            renderer env and rebuild.
          </p>
        </div>
        <Nav onBack={onBack} onNext={onNext} nextLabel="Continue" />
      </StepCard>
    );
  }
  return (
    <StepCard title="Sign in" sub="So your settings sync across machines.">
      <SignedOut>
        <div style={authCardStyle}>
          <SignIn
            routing="virtual"
            forceRedirectUrl="#"
            appearance={brandedClerkAppearance}
          />
        </div>
      </SignedOut>
      <SignedIn>
        <SignedInPanel onNext={onNext} />
      </SignedIn>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <button type="button" onClick={onBack} style={secondaryBtnStyle}>
          Back
        </button>
        <button type="button" onClick={onNext} style={secondaryBtnStyle}>
          Skip sign-in
        </button>
      </div>
    </StepCard>
  );
}

function SignedInPanel({ onNext }: { readonly onNext: () => void }): JSX.Element {
  const { user } = useUser();
  const { update } = usePrefs();

  // Persist the Clerk identity into desktop prefs once on mount.
  useEffect(() => {
    if (!user) return;
    void update({
      clerkUserId: user.id,
      clerkDisplayName:
        user.fullName ??
        user.primaryEmailAddress?.emailAddress ??
        user.username ??
        null,
      signedInAt: Date.now(),
    });
    // We deliberately only run on first mount after user resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <div
      style={{
        padding: '16px 18px',
        background: 'var(--color-primary-soft)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          background: 'var(--color-primary)',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
        }}
      >
        <Icon name="check" size={18} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          Signed in as{' '}
          {user?.fullName ??
            user?.primaryEmailAddress?.emailAddress ??
            'you'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          Click Continue to install the moxxy runtime.
        </div>
      </div>
      <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
    </div>
  );
}
