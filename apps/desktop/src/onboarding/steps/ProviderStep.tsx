/**
 * The provider-connect step — pick a provider from the catalog, then
 * either paste an API key (api-key providers) or run the browser OAuth
 * login (oauth providers), streaming the login subprocess's stdout to a
 * log box. The auth kind re-resolves whenever the provider changes.
 * Applies on first run and whenever the recovery gate finds no provider.
 */

import { useEffect, useState } from 'react';
import { toErrorMessage } from '@/lib/errors';
import { api } from '@/lib/api';
import { StepCard, Nav, PrimaryButton, SuccessRow, inputStyle } from '../chrome';

export function ProviderStep({
  onNext,
  onBack,
}: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  const [catalog, setCatalog] = useState<ReadonlyArray<string>>([
    'anthropic',
    'openai',
    'openai-codex',
  ]);
  const [provider, setProvider] = useState('anthropic');
  const [authKind, setAuthKind] = useState<'oauth' | 'api-key'>('api-key');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loginLog, setLoginLog] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('settings.providerCatalog')
      .then((list) => {
        if (cancelled || list.length === 0) return;
        setCatalog(list);
        setProvider((cur) => (list.includes(cur) ? cur : list[0]!));
      })
      .catch(() => {
        /* keep static fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the auth kind every time the selected provider changes so
  // the UI flips between "Paste API key" and "Sign in with browser".
  useEffect(() => {
    let cancelled = false;
    setDone(false);
    setError(null);
    void api()
      .invoke('onboarding.providerAuthKind', { provider })
      .then((kind) => {
        if (!cancelled) setAuthKind(kind);
      })
      .catch(() => {
        if (!cancelled) setAuthKind('api-key');
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Reuse the install-progress channel so the OAuth subprocess's
  // stdout (the URL prompt, success row, etc.) streams to the
  // log box.
  useEffect(() => {
    const off = api().subscribe('onboarding.install.progress', (line: string) => {
      setLoginLog((cur) => [...cur.slice(-80), line]);
    });
    return off;
  }, []);

  const saveKey = async (): Promise<void> => {
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
      setError(toErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const runOauthLogin = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setLoginLog([]);
    try {
      const code = await api().invoke('onboarding.runProviderLogin', { provider });
      if (code === 0) setDone(true);
      else setError(`moxxy login exit ${code}`);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepCard
      title="Connect a provider"
      sub={
        authKind === 'oauth'
          ? "We'll open your browser to finish signing in. Tokens land in the vault, encrypted."
          : "Drop in an API key from your provider. It's encrypted by the moxxy vault."
      }
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
            {catalog.map((name) => (
              <option key={name} value={name}>
                {name}
                {name === 'openai-codex' ? ' · OAuth' : ''}
              </option>
            ))}
          </select>
        </label>
        {authKind === 'api-key' && (
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
        )}
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--color-red)' }}>
            {error}
          </p>
        )}
        {done && (
          <SuccessRow
            text={
              authKind === 'oauth'
                ? `Signed in to ${provider}.`
                : 'Key saved to the vault.'
            }
          />
        )}
        {authKind === 'oauth' ? (
          <PrimaryButton onClick={() => void runOauthLogin()} disabled={saving}>
            {saving ? 'Waiting for browser…' : done ? `Re-link ${provider}` : `Sign in with ${provider}`}
          </PrimaryButton>
        ) : (
          <PrimaryButton onClick={() => void saveKey()} disabled={saving || !secret.trim()}>
            {saving ? 'Saving…' : done ? 'Update key' : 'Save key'}
          </PrimaryButton>
        )}
        {authKind === 'oauth' && loginLog.length > 0 && (
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 10,
              background: '#0f172a',
              color: '#e2e8f0',
              borderRadius: 10,
              fontSize: 11,
              maxHeight: 140,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {loginLog.slice(-20).join('\n')}
          </pre>
        )}
      </div>
      <Nav onBack={onBack} onNext={onNext} nextLabel={done ? 'Continue' : 'Skip for now'} />
    </StepCard>
  );
}
