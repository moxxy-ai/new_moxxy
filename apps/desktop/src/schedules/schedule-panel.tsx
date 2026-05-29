import { useEffect, useState } from 'react';
import {
  useSchedules,
  type ScheduleEntry,
  type SchedulesApi,
} from '@/lib/schedules';

interface SchedulePanelProps {
  /** Optional injection point for tests / stories. */
  readonly api?: SchedulesApi;
}

/**
 * The scheduler panel. Lists every entry in `~/.moxxy/schedules.json`,
 * lets the user create a new manual entry, toggle enabled state, and
 * delete. The primary runner's poller picks up file changes at its
 * tick interval (default 30s) so there's a brief lag between a desktop
 * mutation and the new cadence taking effect — acceptable for MVP and
 * documented in the help section below.
 */
export function SchedulePanel({ api }: SchedulePanelProps): JSX.Element {
  const fallback = useSchedules();
  const schedules = api ?? fallback;

  return (
    <div
      data-testid="schedule-panel"
      style={{
        position: 'absolute',
        inset: 0,
        overflowY: 'auto',
        padding: '1.5rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: 700,
            letterSpacing: 'var(--tracking-tight)',
          }}
        >
          Schedules
        </h1>
        <span
          className="mono"
          style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}
        >
          {schedules.entries.length} entries
        </span>
      </header>

      <CreateForm api={schedules} />

      {schedules.error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '0.5rem 0.75rem',
            background:
              'color-mix(in oklab, var(--color-pink) 12%, transparent)',
            border: '1px solid var(--color-pink)',
            borderRadius: 'var(--radius-block)',
            fontSize: '0.85rem',
          }}
        >
          {schedules.error}
        </p>
      )}

      {schedules.loading ? (
        <p style={{ color: 'var(--color-text-dim)' }}>Loading…</p>
      ) : schedules.entries.length === 0 ? (
        <p style={{ color: 'var(--color-text-dim)', textAlign: 'center' }}>
          No schedules yet. Add one above.
        </p>
      ) : (
        <ul
          role="list"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          {schedules.entries.map((e) => (
            <ScheduleRow key={e.id} entry={e} api={schedules} />
          ))}
        </ul>
      )}

      <footer
        className="mono"
        style={{
          fontSize: '0.7rem',
          color: 'var(--color-text-dim)',
          textAlign: 'center',
          marginTop: '1rem',
        }}
      >
        The primary runner's poller picks up changes within ~30s.
      </footer>
    </div>
  );
}

function CreateForm({ api }: { readonly api: SchedulesApi }): JSX.Element {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [cronValid, setCronValid] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!cron.trim()) {
      setCronValid(null);
      return;
    }
    const t = window.setTimeout(() => {
      void api.validateCron(cron).then((ok) => {
        if (!cancelled) setCronValid(ok);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cron, api]);

  const canSubmit =
    !submitting && name.trim().length > 0 && prompt.trim().length > 0 && cronValid === true;

  return (
    <form
      data-testid="schedule-create-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        const created = await api.create({
          name: name.trim(),
          prompt: prompt.trim(),
          cron: cron.trim(),
        });
        setSubmitting(false);
        if (created) {
          setName('');
          setPrompt('');
          setCron('0 9 * * *');
        }
      }}
      className="corner-bracket"
      style={{
        padding: '0.75rem 1rem',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-card)',
        borderRadius: 'var(--radius-block)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      <Field label="Name (slug)">
        <input
          data-testid="schedule-create-name"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
          placeholder="daily-standup"
          style={inputStyle}
        />
      </Field>
      <Field label="Prompt">
        <input
          data-testid="schedule-create-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should run?"
          style={inputStyle}
        />
      </Field>
      <Field label="Cron (5 fields)">
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            data-testid="schedule-create-cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * *"
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono)',
              flex: 1,
            }}
          />
          <span
            data-testid="schedule-create-cron-validity"
            data-valid={cronValid === null ? '' : cronValid}
            style={{
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono)',
              color:
                cronValid === true
                  ? 'var(--color-green)'
                  : cronValid === false
                    ? 'var(--color-pink)'
                    : 'var(--color-text-dim)',
            }}
          >
            {cronValid === true ? 'valid' : cronValid === false ? 'invalid' : '…'}
          </span>
        </div>
      </Field>
      <button
        type="submit"
        data-testid="schedule-create-submit"
        disabled={!canSubmit}
        style={{
          alignSelf: 'flex-end',
          padding: '0.4rem 0.9rem',
          background: 'var(--color-primary)',
          color: 'var(--color-bg)',
          borderRadius: 'var(--radius-block)',
          fontWeight: 600,
          opacity: canSubmit ? 1 : 0.4,
        }}
      >
        Create
      </button>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.4rem 0.6rem',
  fontSize: '0.85rem',
  color: 'var(--color-text)',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-block)',
  fontFamily: 'inherit',
  outline: 'none',
};

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.2rem',
        fontSize: '0.75rem',
        color: 'var(--color-text-dim)',
      }}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

function ScheduleRow({
  entry,
  api,
}: {
  readonly entry: ScheduleEntry;
  readonly api: SchedulesApi;
}): JSX.Element {
  const readOnly = entry.source !== 'manual';
  const status =
    entry.lastResult === 'error'
      ? 'error'
      : entry.lastResult === 'ok'
        ? 'ok'
        : 'pending';
  const statusColor =
    status === 'error'
      ? 'var(--color-pink)'
      : status === 'ok'
        ? 'var(--color-green)'
        : 'var(--color-text-dim)';
  return (
    <li
      data-testid={`schedule-row-${entry.id}`}
      data-enabled={entry.enabled}
      style={{
        padding: '0.6rem 0.8rem',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-card)',
        borderRadius: 'var(--radius-block)',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto auto',
        gap: '0.5rem 0.75rem',
        alignItems: 'center',
        opacity: entry.enabled ? 1 : 0.55,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: '0.875rem',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.name}
          {readOnly && (
            <span
              style={{
                marginLeft: '0.5rem',
                fontSize: '0.65rem',
                color: 'var(--color-text-dim)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {entry.source}
            </span>
          )}
        </span>
        <span
          className="mono"
          style={{
            fontSize: '0.7rem',
            color: 'var(--color-text-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.cron ?? formatRunAt(entry.runAt)}
        </span>
      </div>
      <button
        type="button"
        data-testid={`schedule-toggle-${entry.id}`}
        disabled={readOnly}
        onClick={() => void api.setEnabled(entry.id, !entry.enabled)}
        style={{
          fontSize: '0.75rem',
          padding: '0.2rem 0.5rem',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-block)',
          color: entry.enabled
            ? 'var(--color-green)'
            : 'var(--color-text-dim)',
          opacity: readOnly ? 0.4 : 1,
        }}
      >
        {entry.enabled ? 'on' : 'off'}
      </button>
      <button
        type="button"
        data-testid={`schedule-delete-${entry.id}`}
        disabled={readOnly}
        onClick={() => {
          if (window.confirm(`Delete "${entry.name}"?`)) void api.remove(entry.id);
        }}
        aria-label={`Delete schedule ${entry.name}`}
        style={{
          color: 'var(--color-text-dim)',
          fontSize: '0.85rem',
          padding: '0 0.3rem',
          opacity: readOnly ? 0.3 : 1,
        }}
      >
        ×
      </button>
    </li>
  );
}

function formatRunAt(runAt?: number): string {
  if (!runAt) return '—';
  return new Date(runAt).toLocaleString();
}
