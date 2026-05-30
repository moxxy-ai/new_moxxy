/**
 * About / CLI tab — shows the version + on-disk path of the moxxy CLI the
 * desktop is currently running, and an "Update CLI" button that pulls the
 * latest published `@moxxy/cli` into the writable userData copy and
 * restarts the runner so the new binary is used immediately.
 *
 * npm output streams to a log box via the same `onboarding.install.progress`
 * event the onboarding install/login flows use. The bundled CLI keeps
 * working if the update fails (e.g. npm not on PATH).
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toErrorMessage } from '@/lib/errors';
import { Section } from './settings-primitives';

export function AboutTab(): JSX.Element {
  const [info, setInfo] = useState<{ version: string | null; path: string | null } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const loadInfo = (): void => {
    void api()
      .invoke('app.cliInfo')
      .then(setInfo)
      .catch(() => setInfo({ version: null, path: null }));
  };

  useEffect(loadInfo, []);

  // Reuse the install-progress channel so npm's stdout/stderr stream to
  // the log box while the update runs.
  useEffect(() => {
    const off = api().subscribe('onboarding.install.progress', (line: string) => {
      setLog((cur) => [...cur.slice(-80), line]);
    });
    return off;
  }, []);

  const runUpdate = async (): Promise<void> => {
    setUpdating(true);
    setError(null);
    setRestarting(false);
    setLog([]);
    try {
      const { code, version } = await api().invoke('app.updateCli');
      if (code !== 0) {
        setError(`npm install exited with code ${code}.`);
        return;
      }
      setInfo((cur) => ({ version, path: cur?.path ?? null }));
      setRestarting(true);
      // The runner restart is fire-and-forgotten by the handler; re-read
      // the resolved path/version shortly after so the panel reflects the
      // re-pointed MOXXY_CLI_ENTRY.
      loadInfo();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Section
      title="moxxy CLI"
      description="The desktop runs a bundled moxxy CLI. Update to the latest published version without reinstalling the app."
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: '16px 18px',
          background: 'var(--color-card-bg)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 14,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)' }}>
              CLI version
            </span>
            <span className="mono" style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text)' }}>
              {info ? (info.version ?? 'unknown') : '…'}
            </span>
          </div>
          {info?.path && (
            <div
              className="mono"
              title={info.path}
              style={{
                fontSize: 11.5,
                color: 'var(--color-text-dim)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {info.path}
            </div>
          )}
        </div>

        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--color-red)', lineHeight: 1.5 }}>
            {error}
            {/^npm not found/i.test(error) && (
              <>
                {' '}
                Install Node.js to update from within the app; the bundled CLI keeps working otherwise.
              </>
            )}
          </p>
        )}

        {restarting && !error && (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-green)', fontWeight: 600 }}>
            Updated. Runner restarting with the new CLI…
          </p>
        )}

        <button
          type="button"
          data-testid="update-cli"
          onClick={() => void runUpdate()}
          disabled={updating}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 16px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 10,
            color: '#fff',
            background: updating ? 'var(--color-card-border-strong)' : 'var(--color-primary)',
            cursor: updating ? 'default' : 'pointer',
            transition: 'background 140ms',
          }}
        >
          {updating ? 'Updating…' : 'Update CLI'}
        </button>

        {log.length > 0 && (
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
            {log.slice(-40).join('\n')}
          </pre>
        )}
      </div>
    </Section>
  );
}
