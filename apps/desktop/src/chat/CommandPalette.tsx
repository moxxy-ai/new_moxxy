/**
 * Command picker — pure list/filter modal. Selecting a command hands
 * it back to the composer via onPick; the composer is responsible for
 * collecting arguments inline and then calling session.runCommand.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
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
}

/** Known multi-arg commands. Adding a new one here gives the composer
 *  a labelled prompt sequence; commands not listed here default to a
 *  single free-form arg field. */
const COMMAND_STEPPERS: Record<string, ReadonlyArray<ArgStep>> = {
  'vault set': [
    { label: 'Vault key', placeholder: 'OPENAI_API_KEY' },
    { label: 'Value', placeholder: 'sk-…', secret: true },
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

interface Props {
  readonly workspaceId: string;
  readonly onPick: (cmd: CommandInfo) => void;
  readonly onClose: () => void;
}

export function CommandPalette({ workspaceId, onPick, onClose }: Props): JSX.Element {
  const [commands, setCommands] = useState<ReadonlyArray<CommandInfo>>([]);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);

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

  return (
    <Modal title="Commands" onClose={onClose} width={520}>
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
              if (cmd) onPick(cmd);
            }
          }}
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
            <li style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-text-dim)' }}>
              No commands match.
            </li>
          )}
          {filtered.map((cmd, i) => (
            <li key={cmd.name}>
              <button
                type="button"
                onClick={() => onPick(cmd)}
                onMouseEnter={() => setActive(i)}
                className="row-button"
                style={{
                  display: 'flex',
                  width: '100%',
                  textAlign: 'left',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background:
                    i === active ? 'var(--color-primary-soft)' : 'transparent',
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
                </span>
                {stepsForCommand(cmd.name).length > 0 && (
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
        <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-dim)' }}>
          ↑↓ to navigate · ↵ to pick · Esc to close
        </p>
      </div>
    </Modal>
  );
}
