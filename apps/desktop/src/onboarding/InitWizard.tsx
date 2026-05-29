import { useState } from 'react';
import { invoke } from '@/lib/tauri';
import type { RunnerInfo } from '@/lib/runner-info';

interface InitWizardProps {
  /** Latest snapshot. The wizard tailors its options to what the runner
   *  actually advertises; falls back to a curated trio when the list
   *  hasn't loaded yet. */
  readonly info: RunnerInfo | null;
  /** Called once the user has saved a key and switched the active
   *  provider. The host hook will re-probe and dismiss the wizard. */
  readonly onComplete: () => void;
}

const FALLBACK_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI (GPT)' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
];

/**
 * The in-app equivalent of `moxxy init`. Renders when the runner has
 * attached but reports no active provider. Drives the same end state:
 *
 *   1. Vault gets the user's API key (via `settings_set_api_key`,
 *      which pipes through `moxxy vault set <NAME>` so encryption
 *      stays the CLI's responsibility).
 *   2. A minimal `provider:` block is appended to ~/.moxxy/config.yaml
 *      if none exists yet.
 *   3. The runner is asked to switch its active provider so the user's
 *      first turn works without restart.
 */
export function InitWizard({ info, onComplete }: InitWizardProps): JSX.Element {
  const options = info?.providers?.length
    ? info.providers.map((p) => ({ id: p.name, label: p.name }))
    : FALLBACK_PROVIDERS;
  const [provider, setProvider] = useState<string>(options[0]?.id ?? 'anthropic');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = secret.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await invoke('settings_set_api_key', { provider, secret });
      // Tell the runner to use this provider immediately so the very
      // first turn the user types works without a relaunch.
      await invoke('runner_set_provider', { provider });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="init-wizard"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        overflowY: 'auto',
      }}
    >
      <div
        className="corner-bracket elev"
        style={{
          width: '100%',
          maxWidth: 480,
          padding: '1.5rem 1.75rem',
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-block)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <header>
          <h1
            style={{
              margin: 0,
              fontSize: '1.5rem',
              fontWeight: 700,
              letterSpacing: 'var(--tracking-tight)',
            }}
          >
            <span className="grad-text">Pick a provider</span>
          </h1>
          <p
            style={{
              margin: '0.25rem 0 0',
              fontSize: '0.85rem',
              color: 'var(--color-text-dim)',
            }}
          >
            Your key never leaves your machine — it goes straight into
            the moxxy vault that the CLI already manages.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem',
              fontSize: '0.75rem',
              color: 'var(--color-text-dim)',
            }}
          >
            Provider
            <select
              data-testid="init-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              style={{
                padding: '0.4rem 0.6rem',
                fontSize: '0.85rem',
                color: 'var(--color-text)',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-block)',
              }}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem',
              fontSize: '0.75rem',
              color: 'var(--color-text-dim)',
            }}
          >
            API key
            <input
              data-testid="init-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="sk-…"
              autoFocus
              style={{
                padding: '0.4rem 0.6rem',
                fontSize: '0.85rem',
                color: 'var(--color-text)',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-block)',
                fontFamily: 'var(--font-mono)',
              }}
            />
          </label>

          {error && (
            <p
              role="alert"
              style={{
                margin: 0,
                padding: '0.4rem 0.6rem',
                fontSize: '0.8rem',
                background:
                  'color-mix(in oklab, var(--color-pink) 12%, transparent)',
                border: '1px solid var(--color-pink)',
                borderRadius: 'var(--radius-block)',
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            data-testid="init-submit"
            disabled={!canSubmit}
            style={{
              alignSelf: 'flex-end',
              padding: '0.5rem 1rem',
              background: 'var(--color-primary)',
              color: 'var(--color-bg)',
              borderRadius: 'var(--radius-block)',
              fontWeight: 600,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            {submitting ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
