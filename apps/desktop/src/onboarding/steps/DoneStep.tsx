/**
 * The closing step — marks `onboardingComplete` in prefs and hands control
 * back to the app. First-run only.
 */

import { usePrefs } from '@/lib/usePrefs';
import { Icon } from '@/lib/Icon';
import { PrimaryButton } from '../chrome';

export function DoneStep({ onComplete }: { readonly onComplete: () => void }): JSX.Element {
  const { update } = usePrefs();
  const onFinish = async (): Promise<void> => {
    await update({ onboardingComplete: true });
    onComplete();
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 18,
      }}
    >
      <img
        src="/avatar.gif"
        alt=""
        aria-hidden
        style={{ width: 200, height: 'auto', imageRendering: 'pixelated' }}
      />
      <div>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>You&rsquo;re all set!</h2>
        <p
          style={{
            margin: '8px 0 0',
            color: 'var(--color-text-muted)',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          Open your workspaces, send your first message, and tell me what we&rsquo;re building today.
        </p>
      </div>
      <PrimaryButton onClick={() => void onFinish()}>
        Open my workspaces <Icon name="chevron-right" size={14} />
      </PrimaryButton>
    </div>
  );
}
