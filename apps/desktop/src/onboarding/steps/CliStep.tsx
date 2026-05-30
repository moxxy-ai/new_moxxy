/**
 * The moxxy CLI install step — probes the PATH for the CLI on mount,
 * installs it via npm on demand while streaming install progress to a log
 * box, and only enables Continue once the CLI is present. Applies on
 * first run and whenever the recovery gate detects the CLI went missing.
 */

import { useEffect, useState } from 'react';
import { toErrorMessage } from '@/lib/errors';
import { api } from '@/lib/api';
import { StepCard, Nav, PrimaryButton, SuccessRow, Pulse } from '../chrome';

export function CliStep({
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
      setError(toErrorMessage(e));
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
