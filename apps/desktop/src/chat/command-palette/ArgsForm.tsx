/**
 * The args phase of the actions palette — shown only when the picked
 * action takes parameters. Every arg field is rendered AT ONCE (no
 * step-by-step); the user fills them all in and clicks Run (or Cmd/
 * Ctrl+Enter). Back returns to the list; Cancel closes the palette.
 */

import { useState } from 'react';
import { Icon } from '@/lib/Icon';
import { Modal } from '@/lib/Modal';
import { humanize } from './steppers';
import type { ArgStep, CommandInfo } from './types';

export function ArgsForm({
  command,
  steps,
  running,
  onBack,
  onRun,
  onCancel,
}: {
  readonly command: CommandInfo;
  readonly steps: ReadonlyArray<ArgStep>;
  readonly running: boolean;
  readonly onBack: () => void;
  readonly onRun: (values: ReadonlyArray<string>) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [values, setValues] = useState<string[]>(() => steps.map(() => ''));
  const canRun = steps.every((_, i) => values[i]!.trim().length > 0) && !running;

  return (
    <Modal title={humanize(command.name)} onClose={onCancel} width={520}>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) {
            e.preventDefault();
            onRun(values);
          }
        }}
      >
        {command.description && (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            {command.description}
          </p>
        )}
        {steps.map((step, i) => (
          <label key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
              {step.label}
            </span>
            <input
              autoFocus={i === 0}
              type={step.secret ? 'password' : 'text'}
              value={values[i]}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                setValues(next);
              }}
              placeholder={step.placeholder}
              spellCheck={false}
              autoComplete="off"
              disabled={running}
              style={{
                padding: '9px 12px',
                fontSize: 14,
                fontFamily: step.secret ? 'inherit' : 'var(--font-mono)',
                color: 'var(--color-text)',
                background: '#f7f8fc',
                border: '1px solid var(--color-card-border)',
                borderRadius: 10,
                outline: 'none',
              }}
            />
            {step.help && (
              <span style={{ fontSize: 11, color: 'var(--color-text-dim)' }}>{step.help}</span>
            )}
          </label>
        ))}
        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            onClick={onBack}
            disabled={running}
            className="btn-ghost"
            style={{
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              borderRadius: 10,
              background: 'transparent',
            }}
          >
            ← Back
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={running}
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
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onRun(values)}
              disabled={!canRun}
              className="btn-cta"
              style={{
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                background: 'var(--grad-cta)',
                borderRadius: 10,
                opacity: canRun ? 1 : 0.5,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {running ? 'Running…' : 'Run'}
              <Icon name="send" size={13} />
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
