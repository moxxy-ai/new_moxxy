/**
 * Actions palette — formerly "Commands". Exposes the runner's
 * `command.run` capabilities to the user as one-click actions.
 *
 * Two phases:
 *
 *   1. List view — quick-filter list of every action; ↑↓/Enter to
 *      navigate, click to pick.
 *   2. Args form (only when the action takes parameters) — every
 *      arg field rendered AT ONCE so the user fills them all in
 *      and clicks Run; no step-by-step.
 *
 * Actions with no args run as soon as they're picked. Successful and
 * failed results show up in the transcript as a dismissible bordered
 * `action_result` block.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';
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

export interface ArgStep {
  readonly label: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly multiline?: boolean;
  readonly help?: string;
}

/** Args schemas for known multi-arg actions. Adding more is one entry. */
const COMMAND_STEPPERS: Record<string, ReadonlyArray<ArgStep>> = {
  'vault set': [
    { label: 'Vault key', placeholder: 'OPENAI_API_KEY', help: 'The env-var name the agent looks up.' },
    { label: 'Value', placeholder: 'sk-…', secret: true, help: 'Stored encrypted in the vault.' },
  ],
  'vault remove': [{ label: 'Vault key', placeholder: 'OPENAI_API_KEY' }],
  'vault get': [{ label: 'Vault key', placeholder: 'OPENAI_API_KEY' }],
  'provider use': [{ label: 'Provider name', placeholder: 'anthropic' }],
  'mode use': [{ label: 'Mode name', placeholder: 'tool-use' }],
};

export function stepsForCommand(commandName: string): ReadonlyArray<ArgStep> {
  const exact = COMMAND_STEPPERS[commandName];
  if (exact) return exact;
  for (const [k, v] of Object.entries(COMMAND_STEPPERS)) {
    if (commandName.startsWith(`${k} `) || k.startsWith(`${commandName} `)) return v;
  }
  return [];
}

function quote(v: string): string {
  if (/^[A-Za-z0-9_\-./@]+$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}

interface Props {
  readonly workspaceId: string;
  readonly onClose: () => void;
}

export function CommandPalette({ workspaceId, onClose }: Props): JSX.Element {
  const [commands, setCommands] = useState<ReadonlyArray<CommandInfo>>([]);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [running, setRunning] = useState(false);
  const [argsFor, setArgsFor] = useState<{
    command: CommandInfo;
    steps: ReadonlyArray<ArgStep>;
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

  const run = async (command: CommandInfo, values: ReadonlyArray<string>): Promise<void> => {
    setRunning(true);
    const argString = values.map(quote).join(' ');
    try {
      const result = await api().invoke('session.runCommand', {
        workspaceId,
        name: command.name,
        args: argString,
      });
      const tone =
        result.kind === 'error'
          ? 'error'
          : result.kind === 'session-action'
            ? 'notice'
            : 'info';
      const text =
        result.kind === 'text'
          ? result.text ?? ''
          : result.kind === 'error'
            ? result.message ?? 'command failed'
            : result.kind === 'session-action'
              ? result.notice ?? ''
              : '';
      // 'clear' is a side-effect-only directive — wipe transcript
      // BEFORE dispatching, otherwise the result card would land in
      // the cleared transcript and immediately disappear.
      if (result.kind === 'session-action' && result.action === 'clear') {
        chatStore.clear(workspaceId);
      }
      chatStore.dispatch(workspaceId, {
        type: 'action_result',
        commandName: command.name,
        argsLine: argString,
        tone,
        text,
      });
      onClose();
    } catch (e) {
      chatStore.dispatch(workspaceId, {
        type: 'action_result',
        commandName: command.name,
        argsLine: argString,
        tone: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
      onClose();
    } finally {
      setRunning(false);
    }
  };

  const onSelect = (cmd: CommandInfo): void => {
    const steps = stepsForCommand(cmd.name);
    if (steps.length === 0) {
      void run(cmd, []);
      return;
    }
    setArgsFor({ command: cmd, steps });
  };

  if (argsFor) {
    return (
      <ArgsForm
        command={argsFor.command}
        steps={argsFor.steps}
        running={running}
        onBack={() => setArgsFor(null)}
        onRun={(values) => void run(argsFor.command, values)}
        onCancel={onClose}
      />
    );
  }

  return (
    <Modal title="Actions" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          autoFocus
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const cmd = filtered[active];
              if (cmd && !running) onSelect(cmd);
            }
          }}
          placeholder="Filter actions…"
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
          aria-label="Available actions"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 4,
            maxHeight: 380,
            overflowY: 'auto',
            border: '1px solid var(--color-card-border)',
            borderRadius: 10,
          }}
        >
          {filtered.length === 0 && (
            <li style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-text-dim)' }}>
              No actions match.
            </li>
          )}
          {filtered.map((cmd, i) => {
            const hasArgs = stepsForCommand(cmd.name).length > 0;
            return (
              <li key={cmd.name}>
                <button
                  type="button"
                  onClick={() => onSelect(cmd)}
                  onMouseEnter={() => setActive(i)}
                  disabled={running}
                  className="row-button"
                  style={{
                    display: 'flex',
                    width: '100%',
                    textAlign: 'left',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: i === active ? 'var(--color-primary-soft)' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      color: 'var(--color-text)',
                      minWidth: 110,
                      flexShrink: 0,
                    }}
                  >
                    {humanize(cmd.name)}
                  </span>
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                    {cmd.description || 'No description'}
                  </span>
                  {hasArgs && (
                    <span
                      title="Will prompt for arguments before running"
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
            );
          })}
        </ul>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-dim)' }}>
          ↑↓ to navigate · ↵ to run · Esc to close
        </p>
      </div>
    </Modal>
  );
}

function ArgsForm({
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

/** Convert "vault set" / "mode use" → "Vault set" / "Mode use" for
 *  the user-facing label. The runner registers these with terminal
 *  syntax that doesn't read well in a friendly action picker. */
function humanize(name: string): string {
  return name
    .split(' ')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
