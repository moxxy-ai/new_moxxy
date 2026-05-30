/**
 * Account modal shown when the user clicks their profile pill in the
 * sidebar footer. Reads the current Clerk user via useUser() and
 * exposes:
 *
 *   - Header with name + email + tier badge.
 *   - Account details (joined date, identifier).
 *   - Sign-out button that clears Clerk session + cached prefs.
 *
 * Kept lightweight so we don't pull in Clerk's UserProfile component
 * (which carries its own card chrome that clashes with the rest of
 * the app).
 */

import { useState } from 'react';
import { useClerk, useUser } from '@clerk/clerk-react';
import { Modal, ConfirmModal } from '@/lib/Modal';
import { Icon } from '@/lib/Icon';
import { usePrefs } from '@/lib/usePrefs';

interface Props {
  readonly tier: string;
  readonly onClose: () => void;
}

export function ProfileView({ tier, onClose }: Props): JSX.Element {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { prefs, update } = usePrefs();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [busy, setBusy] = useState(false);

  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const fullName =
    user?.fullName ?? email ?? prefs?.clerkDisplayName ?? 'Account';
  const joined = user?.createdAt ? new Date(user.createdAt) : null;
  const initials =
    fullName
      .match(/\b\w/g)
      ?.slice(0, 2)
      .join('')
      .toUpperCase() ?? 'M';

  const doSignOut = async (): Promise<void> => {
    setBusy(true);
    try {
      await signOut();
      await update({
        clerkUserId: null,
        clerkDisplayName: null,
        signedInAt: null,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal title="Account" onClose={onClose} width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '6px 4px',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: 'linear-gradient(135deg, #f59e0b, #f472b6)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 18,
                letterSpacing: '0.04em',
                flexShrink: 0,
                boxShadow: '0 10px 24px -16px rgba(244, 114, 182, 0.7)',
              }}
            >
              {initials}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'var(--color-text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={fullName}
              >
                {fullName}
              </div>
              {email && fullName !== email && (
                <div
                  className="mono"
                  style={{
                    marginTop: 2,
                    fontSize: 11.5,
                    color: 'var(--color-text-dim)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={email}
                >
                  {email}
                </div>
              )}
            </div>
            <span style={tierBadgeStyle(tier)}>{tier}</span>
          </div>

          <hr
            style={{
              border: 'none',
              borderTop: '1px solid var(--color-card-border)',
              margin: 0,
            }}
          />

          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: '110px 1fr',
              rowGap: 8,
              columnGap: 14,
              fontSize: 12.5,
            }}
          >
            <Detail label="Member since" value={joined ? joined.toLocaleDateString() : 'Just now'} />
            <Detail label="User ID" value={user?.id ?? '—'} mono />
            {prefs?.signedInAt && (
              <Detail
                label="Last sign-in"
                value={new Date(prefs.signedInAt).toLocaleString()}
              />
            )}
          </dl>

          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
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
              Close
            </button>
            <button
              type="button"
              onClick={() => setConfirmSignOut(true)}
              disabled={busy}
              className="btn-cta"
              style={{
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                background: 'var(--color-red)',
                borderRadius: 10,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon name="x" size={13} />
              Sign out
            </button>
          </footer>
        </div>
      </Modal>
      {confirmSignOut && (
        <ConfirmModal
          title="Sign out?"
          message="You'll be returned to a guest session. Your workspaces and chats stay on this machine."
          confirmLabel="Sign out"
          destructive
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => {
            setConfirmSignOut(false);
            void doSignOut();
          }}
        />
      )}
    </>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): JSX.Element {
  return (
    <>
      <dt style={{ color: 'var(--color-text-dim)', fontWeight: 600 }}>{label}</dt>
      <dd
        className={mono ? 'mono' : undefined}
        title={value}
        style={{
          margin: 0,
          color: 'var(--color-text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </dd>
    </>
  );
}

function tierBadgeStyle(tier: string): React.CSSProperties {
  const isFree = tier.toLowerCase() === 'free';
  return {
    padding: '3px 10px',
    borderRadius: 999,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    fontSize: 10.5,
    background: isFree
      ? 'rgba(148, 163, 184, 0.18)'
      : 'linear-gradient(135deg, rgba(236, 72, 153, 0.95), rgba(217, 70, 239, 0.95))',
    color: isFree ? 'var(--color-text-muted)' : '#fff',
    border: isFree ? '1px solid rgba(148, 163, 184, 0.32)' : 'none',
    flexShrink: 0,
  };
}
