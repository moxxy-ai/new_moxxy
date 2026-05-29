/**
 * First-run wizard. Shown until `prefs.onboardingComplete === true`.
 *
 * Step sequence:
 *
 *   1. Welcome — brand hero + summary of what's about to happen.
 *   2. Sign in — Clerk's <SignIn /> in an embedded card; persists
 *      the resulting Clerk user id into prefs.
 *   3. moxxy CLI — runs the existing install flow if missing.
 *   4. Provider — pick an LLM provider + paste its key (existing
 *      saveProviderKey IPC).
 *   5. Workspace — point at a folder for the first workspace
 *      (skippable; the unbound runner is fine too).
 *   6. Done — celebratory hero, "Open my workspaces" CTA marks
 *      onboarding complete in prefs.
 *
 * The Clerk publishable key comes from `VITE_CLERK_PUBLISHABLE_KEY`;
 * if unset we still let the user finish (the auth step shows an
 * inline note explaining auth is disabled) so dev builds without a
 * Clerk app configured aren't blocked.
 */

import { useEffect, useState } from 'react';
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useUser,
} from '@clerk/clerk-react';
import { api } from '@/lib/api';
import { usePrefs } from '@/lib/usePrefs';
import { useDesks } from '@/lib/useDesks';
import { Icon } from '@/lib/Icon';

type StepId = 'welcome' | 'auth' | 'cli' | 'provider' | 'workspace' | 'done';

const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'auth', label: 'Sign in' },
  { id: 'cli', label: 'Install moxxy' },
  { id: 'provider', label: 'Pick a provider' },
  { id: 'workspace', label: 'First workspace' },
  { id: 'done', label: 'You\'re set' },
];

interface Props {
  readonly onComplete: () => void;
}

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export function FirstRunWizard({ onComplete }: Props): JSX.Element {
  const [step, setStep] = useState<StepId>('welcome');

  const content = (
    <Shell step={step}>
      {step === 'welcome' && <WelcomeStep onNext={() => setStep('auth')} />}
      {step === 'auth' && (
        <AuthStep onNext={() => setStep('cli')} onBack={() => setStep('welcome')} />
      )}
      {step === 'cli' && (
        <CliStep onNext={() => setStep('provider')} onBack={() => setStep('auth')} />
      )}
      {step === 'provider' && (
        <ProviderStep onNext={() => setStep('workspace')} onBack={() => setStep('cli')} />
      )}
      {step === 'workspace' && (
        <WorkspaceStep onNext={() => setStep('done')} onBack={() => setStep('provider')} />
      )}
      {step === 'done' && <DoneStep onComplete={onComplete} />}
    </Shell>
  );

  // ClerkProvider wraps the wizard so SignIn / useUser have access to
  // the Clerk client. Without a publishable key we skip the provider
  // and AuthStep falls back to a "local mode" message.
  if (CLERK_KEY) {
    return (
      <ClerkProvider publishableKey={CLERK_KEY} appearance={brandedClerkAppearance}>
        {content}
      </ClerkProvider>
    );
  }
  return content;
}

/**
 * Strip every piece of Clerk's default chrome (card border + shadow,
 * brand header, "Secured by Clerk" footer, OAuth icons) and recolour
 * the bits we keep so the embedded SignIn reads as part of our
 * wizard. The footer's "Development mode" badge is added by Clerk's
 * dev key — it's intentional and disappears when you swap in a
 * production key.
 */
const brandedClerkAppearance = {
  variables: {
    colorPrimary: '#ec4899',
    colorBackground: '#ffffff',
    colorText: '#0f172a',
    colorTextSecondary: '#475569',
    colorInputBackground: '#f7f8fc',
    colorInputText: '#0f172a',
    colorDanger: '#ef4444',
    borderRadius: '10px',
    fontFamily:
      "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  },
  layout: {
    logoPlacement: 'none',
    showOptionalFields: false,
    socialButtonsVariant: 'blockButton',
    socialButtonsPlacement: 'top',
    helpPageUrl: '',
  },
  elements: {
    rootBox: { width: '100%' },
    cardBox: {
      width: '100%',
      maxWidth: 'none',
      boxShadow: 'none',
      border: 'none',
      background: 'transparent',
    },
    card: {
      width: '100%',
      maxWidth: 'none',
      background: 'transparent',
      boxShadow: 'none',
      border: 'none',
      padding: 0,
    },
    main: { width: '100%', gap: 12 },
    form: { width: '100%', gap: 12 },
    headerTitle: { display: 'none' },
    headerSubtitle: { display: 'none' },
    logoBox: { display: 'none' },
    footer: { display: 'none' },
    footerAction: { display: 'none' },
    socialButtonsBlockButton: {
      border: '1px solid var(--color-card-border)',
      background: '#fff',
      color: 'var(--color-text)',
      fontWeight: 600,
      borderRadius: 10,
    },
    socialButtonsBlockButtonText: { fontWeight: 600 },
    dividerLine: { background: 'var(--color-card-border)' },
    dividerText: {
      color: 'var(--color-text-dim)',
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
    },
    formFieldLabel: {
      fontSize: 12.5,
      fontWeight: 600,
      color: 'var(--color-text-muted)',
    },
    formFieldInput: {
      background: '#f7f8fc',
      border: '1px solid var(--color-card-border)',
      borderRadius: 10,
      padding: '10px 12px',
      fontSize: 14,
    },
    formButtonPrimary: {
      background: 'var(--grad-cta)',
      color: '#fff',
      fontWeight: 600,
      borderRadius: 10,
      boxShadow: '0 10px 20px -12px rgba(236, 72, 153, 0.55)',
      textTransform: 'none',
    },
    identityPreviewEditButton: { color: 'var(--color-primary-strong)' },
  },
} as const;

// ---------- Shell ----------------------------------------------------------

function Shell({
  step,
  children,
}: {
  readonly step: StepId;
  readonly children: React.ReactNode;
}): JSX.Element {
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-app-bg)',
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        overflow: 'hidden',
      }}
    >
      <aside
        style={{
          background: 'var(--color-card-bg)',
          borderRight: '1px solid var(--color-card-border)',
          padding: '24px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src="/logo.png"
            alt=""
            aria-hidden
            width={32}
            height={32}
            style={{ imageRendering: 'pixelated', borderRadius: 8 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>MoxxyAI</span>
            <span
              style={{
                fontSize: 10.5,
                color: 'var(--color-text-dim)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Workspaces
            </span>
          </div>
        </header>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>
          Let&rsquo;s get you set up.
        </h1>
        <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 13.5 }}>
          A few quick steps and you&rsquo;ll have your own AI workspace running locally.
        </p>
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {STEPS.map((s, i) => {
            const done = i < idx;
            const current = i === idx;
            return (
              <li
                key={s.id}
                aria-current={current ? 'step' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 10px',
                  borderRadius: 9,
                  background: current ? 'var(--color-primary-soft)' : 'transparent',
                  color: current
                    ? 'var(--color-primary-strong)'
                    : done
                      ? 'var(--color-text-muted)'
                      : 'var(--color-text-dim)',
                  fontWeight: current ? 600 : 500,
                  fontSize: 13,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: done
                      ? 'var(--color-green)'
                      : current
                        ? 'var(--color-primary)'
                        : 'var(--color-card-border)',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {done ? <Icon name="check" size={12} /> : i + 1}
                </span>
                {s.label}
              </li>
            );
          })}
        </ol>
        <span style={{ flex: 1 }} />
        <footer
          className="mono"
          style={{ fontSize: 10.5, color: 'var(--color-text-dim)' }}
        >
          You can run through this again from Settings → About at any time.
        </footer>
      </aside>
      <main
        style={{
          display: 'grid',
          placeItems: 'center',
          padding: '24px 32px',
          overflowY: 'auto',
        }}
      >
        <div style={{ width: '100%', maxWidth: 540 }}>{children}</div>
      </main>
    </div>
  );
}

// ---------- Steps ----------------------------------------------------------

function WelcomeStep({ onNext }: { readonly onNext: () => void }): JSX.Element {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 18 }}
    >
      <img
        src="/avatar.png"
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

function AuthStep({
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
          <SignIn routing="virtual" forceRedirectUrl="#" />
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

function CliStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  type State = 'probing' | 'present' | 'missing' | 'installing' | 'failed';
  const [state, setState] = useState<State>('probing');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('onboarding.status')
      .then((status) => {
        if (cancelled) return;
        setState(status.cliPath ? 'present' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setState('missing');
      });
    const off = api().subscribe('onboarding.install.progress', (line: string) => {
      setLogLines((cur) => [...cur.slice(-200), line]);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const install = async (): Promise<void> => {
    setState('installing');
    setLogLines([]);
    setError(null);
    try {
      const code = await api().invoke('onboarding.installMoxxyCli');
      if (code === 0) setState('present');
      else {
        setState('failed');
        setError(`npm exit ${code}`);
      }
    } catch (e) {
      setState('failed');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <StepCard
      title="Install moxxy"
      sub="The moxxy CLI runs your agent locally. We use npm to install it."
    >
      {state === 'probing' && <Pulse label="Looking for moxxy on your PATH…" />}
      {state === 'present' && (
        <SuccessRow text="moxxy is installed and ready." />
      )}
      {(state === 'missing' || state === 'failed') && (
        <div
          style={{
            padding: '14px 16px',
            background: '#fdf2f8',
            border: '1px solid var(--color-card-border)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {state === 'missing' ? 'moxxy isn\'t installed yet.' : 'Install failed.'}
          </div>
          {error && <div style={{ color: 'var(--color-red)' }}>{error}</div>}
          <PrimaryButton onClick={() => void install()}>
            {state === 'failed' ? 'Try again' : 'Install moxxy'}
          </PrimaryButton>
        </div>
      )}
      {state === 'installing' && (
        <>
          <Pulse label="Installing moxxy via npm…" />
          {logLines.length > 0 && (
            <pre
              className="mono"
              style={{
                margin: 0,
                padding: 10,
                background: '#0f172a',
                color: '#e2e8f0',
                borderRadius: 10,
                fontSize: 11,
                maxHeight: 180,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {logLines.slice(-40).join('\n')}
            </pre>
          )}
        </>
      )}
      <Nav onBack={onBack} onNext={onNext} nextDisabled={state !== 'present'} />
    </StepCard>
  );
}

function ProviderStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  const [provider, setProvider] = useState('anthropic');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const save = async (): Promise<void> => {
    if (!secret.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api().invoke('onboarding.saveProviderKey', {
        provider,
        secret: secret.trim(),
      });
      setSecret('');
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepCard
      title="Connect a provider"
      sub="Drop in an API key from your provider. It's encrypted by the moxxy vault."
    >
      <div
        style={{
          padding: '16px 18px',
          background: 'var(--color-card-bg)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            Provider
          </span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={inputStyle}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            API key
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="sk-…"
            style={inputStyle}
          />
        </label>
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--color-red)' }}>
            {error}
          </p>
        )}
        {done && <SuccessRow text="Key saved to the vault." />}
        <PrimaryButton onClick={() => void save()} disabled={saving || !secret.trim()}>
          {saving ? 'Saving…' : done ? 'Update key' : 'Save key'}
        </PrimaryButton>
      </div>
      <Nav onBack={onBack} onNext={onNext} nextLabel={done ? 'Continue' : 'Skip for now'} />
    </StepCard>
  );
}

function WorkspaceStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  const desks = useDesks();
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState('My workspace');
  const [creating, setCreating] = useState(false);

  const onPickFolder = async (): Promise<void> => {
    const f = await desks.pickFolder();
    if (f) {
      setFolder(f);
      setName(f.split('/').filter(Boolean).pop() ?? 'My workspace');
    }
  };

  const onCreate = async (): Promise<void> => {
    if (!folder || !name.trim()) return;
    setCreating(true);
    try {
      const desk = await desks.create(name.trim(), folder);
      if (desk) await desks.setActive(desk.id);
      onNext();
    } finally {
      setCreating(false);
    }
  };

  const hasAny = desks.desks.length > 0;

  return (
    <StepCard
      title="Pick a workspace"
      sub="A workspace is a folder I'll operate in. You can add more later."
    >
      {hasAny && (
        <SuccessRow
          text={`You already have ${desks.desks.length} workspace${desks.desks.length === 1 ? '' : 's'}.`}
        />
      )}
      <div
        style={{
          padding: '16px 18px',
          background: 'var(--color-card-bg)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <button type="button" onClick={() => void onPickFolder()} style={pickerBtnStyle}>
          <Icon name="workspace" size={16} />
          {folder ? folder : 'Choose a folder…'}
        </button>
        {folder && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </label>
        )}
        <PrimaryButton
          onClick={() => void onCreate()}
          disabled={!folder || !name.trim() || creating}
        >
          {creating ? 'Creating…' : 'Create workspace'}
        </PrimaryButton>
      </div>
      <Nav onBack={onBack} onNext={onNext} nextLabel="Skip for now" />
    </StepCard>
  );
}

function DoneStep({ onComplete }: { readonly onComplete: () => void }): JSX.Element {
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
        src="/avatar.png"
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

// ---------- Shared primitives ---------------------------------------------

function StepCard({
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

function Nav({
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

function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
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

function SuccessRow({ text }: { readonly text: string }): JSX.Element {
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

function Pulse({ label }: { readonly label: string }): JSX.Element {
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
        src="/avatar.png"
        alt=""
        aria-hidden
        className="moxxy-avatar-loader moxxy-avatar-loader--sm"
        style={{ width: 28, height: 'auto', imageRendering: 'pixelated' }}
      />
      {label}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--color-text)',
  background: '#fff',
  border: '1px solid var(--color-card-border)',
  borderRadius: 10,
  outline: 'none',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  color: '#fff',
  background: 'var(--grad-cta)',
  border: 'none',
  borderRadius: 10,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  boxShadow: '0 10px 20px -12px rgba(236, 72, 153, 0.55)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  background: 'transparent',
  border: '1px solid var(--color-card-border)',
  borderRadius: 10,
};

const pickerBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  fontSize: 13,
  color: 'var(--color-text)',
  background: '#f7f8fc',
  border: '1px dashed var(--color-card-border-strong)',
  borderRadius: 10,
  textAlign: 'left',
  width: '100%',
};

// --- Auth styles -----------------------------------------------------------

/** Outer wrapper that draws our card chrome so the SignIn component
 *  (whose own card is now hidden via appearance.elements.card) sits
 *  inside the same chrome as every other onboarding step. */
const authCardStyle: React.CSSProperties = {
  padding: '18px 18px 16px',
  background: 'var(--color-card-bg)',
  border: '1px solid var(--color-card-border)',
  borderRadius: 12,
};
