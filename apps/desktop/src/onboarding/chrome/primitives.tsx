/**
 * Shared onboarding step primitives — the small building blocks every step
 * composes: StepCard (title + sub + body), Nav (Back / Next footer),
 * PrimaryButton (the gradient CTA), SuccessRow (the green confirmed row),
 * and Pulse (the avatar loading row). Style tokens live in ./styles; this
 * module is otherwise self-contained so it stays a dependency leaf.
 */

import { Icon } from '@/lib/Icon';
import { primaryBtnStyle, secondaryBtnStyle } from './styles';

// ---- StepCard -------------------------------------------------------------

export function StepCard({
  title,
  sub,
  children,
}: {
  readonly title: string;
  readonly sub: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{title}</h2>
        <p
          style={{
            margin: '6px 0 0',
            color: 'var(--color-text-muted)',
            fontSize: 13.5,
            lineHeight: 1.6,
          }}
        >
          {sub}
        </p>
      </header>
      {children}
    </div>
  );
}

// ---- Nav ------------------------------------------------------------------

export function Nav({
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled,
}: {
  readonly onBack: () => void;
  readonly onNext: () => void;
  readonly nextLabel?: string;
  readonly nextDisabled?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
      <button type="button" onClick={onBack} style={secondaryBtnStyle}>
        Back
      </button>
      <PrimaryButton onClick={onNext} disabled={nextDisabled}>
        {nextLabel}
      </PrimaryButton>
    </div>
  );
}

// ---- PrimaryButton --------------------------------------------------------

export function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={`btn-cta ${rest.className ?? ''}`.trim()}
      style={{
        ...primaryBtnStyle,
        opacity: rest.disabled ? 0.5 : 1,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ---- SuccessRow -----------------------------------------------------------

export function SuccessRow({ text }: { readonly text: string }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: '#dcfce7',
        border: '1px solid #bbf7d0',
        borderRadius: 10,
        fontSize: 13,
        color: '#166534',
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          background: 'var(--color-green)',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="check" size={13} />
      </span>
      {text}
    </div>
  );
}

// ---- Pulse ----------------------------------------------------------------

export function Pulse({ label }: { readonly label: string }): JSX.Element {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: 'var(--color-text-muted)',
      }}
    >
      <img
        src="/avatar.gif"
        alt=""
        aria-hidden
        className="moxxy-avatar-loader moxxy-avatar-loader--sm"
        style={{ width: 28, height: 'auto', imageRendering: 'pixelated' }}
      />
      {label}
    </div>
  );
}
