/**
 * Slash-command palette for the composer.
 *
 * The runner advertises every available slash command in
 * SessionInfo.commands (name + description + optional aliases). We
 * pop those in a quick modal where the user can type to filter and
 * pick one. On click we either:
 *
 *   - Insert "/<name> " straight into the composer when the command
 *     takes no positional args.
 *   - Walk a small stepper for known multi-arg commands (e.g.
 *     /vault set <key> <value>) so the user gets prompted for each
 *     piece rather than having to remember the order.
 *
 * The stepper is keyed by command name; adding more commands later
 * is a single entry in COMMAND_STEPPERS.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/lib/Icon';
import { Modal } from '@/lib/Modal';

interface CommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly channels?: ReadonlyArray<string>;
  readonly pendingNotice?: string;
}

interface SessionInfoSlice {
  readonly commands?: ReadonlyArray<CommandInfo>;
}

/** Per-command arg prompts. Each entry walks the user through the
 *  required parameters and assembles the final command line. */
const COMMAND_STEPPERS: Record<string, ReadonlyArray<{ label: string; placeholder?: string; secret?: boolean }>> = {
  'vault set': [
    { label: 'Vault key', placeholder: 'OPENAI_API_KEY' },
    { label: 'Value', placeholder: 'sk-…', secret: true },
  ],
  'vault remove': [{ label: 'Vault key', placeholder: 'OPENAI_API_KEY' }],
  'vault get': [{ label: 'Vault key', placeholder: 'OPENAI_API_KEY' }],
  'provider use': [{ label: 'Provider name', placeholder: 'anthropic' }],
  'mode use': [{ label: 'Mode name', placeholder: 'tool-use' }],
};

function steppersFor(commandName: string): ReadonlyArray<{ label: string; placeholder?: string; secret?: boolean }> | null {
  // Match "name" or "name subverb" against the stepper key.
  return (
    COMMAND_STEPPERS[commandName] ??
    Object.entries(COMMAND_STEPPERS).find(([k]) => commandName.startsWith(`${k} `) || k.startsWith(`${commandName} `))?.[1] ??
    null
  );
}

interface Props {
  readonly workspaceId: string;
  readonly onPick: (text: string) => void;
  readonly onClose: () => void;
}

export function CommandPalette({ workspaceId, onPick, onClose }: Props): JSX.Element {
  const [commands, setCommands] = useState<ReadonlyArray<CommandInfo>>([]);
  const [filter, setFilter] = useState('');
  const [stepper, setStepper] = useState<{
    commandName: string;
    steps: ReadonlyArray<{ label: string; placeholder?: string; secret?: boolean }>;
    index: number;
    values: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api()
      .invoke('session.info', { workspaceId })
      .then((raw) => {
        if (cancelled) return;
        const info = raw as SessionInfoSlice | null;
        if (info?.commands) setCommands(info.commands);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (c.description?.toLowerCase().includes(q)) return true;
      if (c.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [commands, filter]);

  const onSelect = (cmd: CommandInfo): void => {
    const steps = steppersFor(cmd.name);
    if (steps) {
      setStepper({ commandName: cmd.name, steps, index: 0, values: [] });
      return;
    }
    onPick(`/${cmd.name} `);
  };

  if (stepper) {
    return (
      <StepperModal
        title={`/${stepper.commandName}`}
        steps={stepper.steps}
        values={stepper.values}
        index={stepper.index}
        onCancel={() => setStepper(null)}
        onNext={(value) => {
          const nextValues = [...stepper.values, value];
          if (stepper.index + 1 >= stepper.steps.length) {
            const args = nextValues.map((v) => quote(v)).join(' ');
            onPick(`/${stepper.commandName} ${args}`);
            return;
          }
          setStepper({ ...stepper, index: stepper.index + 1, values: nextValues });
        }}
      />
    );
  }

  return (
    <Modal title="Commands" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter commands…"
          style={{
            padding: '9px 12px',
            fontSize: 13.5,
            color: 'var(--color-text)',
            background: '#f7f8fc',
            border: '1px solid var(--color-card-border)',
            borderRadius: 10,
            outline: 'none',
          }}
        />
        <ul
          role="listbox"
          aria-label="Available commands"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 4,
            maxHeight: 360,
            overflowY: 'auto',
            border: '1px solid var(--color-card-border)',
            borderRadius: 10,
          }}
        >
          {filtered.length === 0 && (
            <li
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--color-text-dim)',
              }}
            >
              No commands match.
            </li>
          )}
          {filtered.map((cmd) => (
            <li key={cmd.name}>
              <button
                type="button"
                onClick={() => onSelect(cmd)}
                className="row-button"
                style={{
                  display: 'flex',
                  width: '100%',
                  textAlign: 'left',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '8px 10px',
                  borderRadius: 8,
                }}
              >
                <span
                  className="mono"
                  style={{
                    color: 'var(--color-primary-strong)',
                    fontWeight: 600,
                    fontSize: 13,
                    minWidth: 110,
                    flexShrink: 0,
                  }}
                >
                  /{cmd.name}
                </span>
                <span style={{ flex: 1, fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                  {cmd.description || 'No description'}
                  {cmd.aliases && cmd.aliases.length > 0 && (
                    <span
                      className="mono"
                      style={{
                        marginLeft: 8,
                        fontSize: 10.5,
                        color: 'var(--color-text-dim)',
                      }}
                    >
                      aliases: {cmd.aliases.join(', ')}
                    </span>
                  )}
                </span>
                {steppersFor(cmd.name) && (
                  <span
                    className="mono"
                    title="Will prompt for arguments"
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: 'var(--color-primary-soft)',
                      color: 'var(--color-primary-strong)',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      fontWeight: 700,
                    }}
                  >
                    Args
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function StepperModal({
  title,
  steps,
  values,
  index,
  onCancel,
  onNext,
}: {
  readonly title: string;
  readonly steps: ReadonlyArray<{ label: string; placeholder?: string; secret?: boolean }>;
  readonly values: ReadonlyArray<string>;
  readonly index: number;
  readonly onCancel: () => void;
  readonly onNext: (value: string) => void;
}): JSX.Element {
  const step = steps[index]!;
  const [value, setValue] = useState('');
  const isLast = index + 1 >= steps.length;

  return (
    <Modal title={title} onClose={onCancel} width={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onNext(value);
          setValue('');
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div
          className="mono"
          style={{ fontSize: 11.5, color: 'var(--color-text-dim)', letterSpacing: '0.04em' }}
        >
          Step {index + 1} of {steps.length}
        </div>
        {values.length > 0 && (
          <ul
            className="mono"
            style={{
              margin: 0,
              padding: '8px 10px',
              background: '#f7f8fc',
              border: '1px solid var(--color-card-border)',
              borderRadius: 8,
              listStyle: 'none',
              fontSize: 11.5,
              color: 'var(--color-text-dim)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {values.map((v, i) => (
              <li key={i}>
                {steps[i]!.label}: {steps[i]!.secret ? '••••' : v}
              </li>
            ))}
          </ul>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)' }}>
            {step.label}
          </span>
          <input
            autoFocus
            type={step.secret ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={step.placeholder}
            spellCheck={false}
            autoComplete="off"
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
        </label>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
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
            type="submit"
            disabled={!value.trim()}
            className="btn-cta"
            style={{
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--grad-cta)',
              borderRadius: 10,
              opacity: value.trim() ? 1 : 0.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isLast ? 'Insert command' : 'Next'}
            <Icon name="chevron-right" size={13} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** Quote an argument for the slash-command line. Values with spaces
 *  get double-quoted; embedded double-quotes are escaped. Numbers /
 *  unquoted-safe strings pass through. */
function quote(v: string): string {
  if (/^[A-Za-z0-9_\-./@]+$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}
