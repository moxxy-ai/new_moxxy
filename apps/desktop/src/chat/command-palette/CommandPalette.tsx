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
 *
 * This container owns the command fetch + filtering + run/dispatch; the
 * args form lives in its own module.
 */

import { useEffect, useMemo, useState } from 'react';
import { toErrorMessage } from '@/lib/errors';
import { api } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';
import { Modal } from '@/lib/Modal';
import { ArgsForm } from './ArgsForm';
import { humanize, quote, stepsForCommand } from './steppers';
import type { ArgStep, CommandInfo, SessionInfoSlice } from './types';

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
      // 'clear' is a side-effect-only directive — wipe transcript
      // BEFORE dispatching, otherwise the result card would land in
      // the cleared transcript and immediately disappear.
      if (result.kind === 'session-action' && result.action === 'clear') {
        chatStore.clear(workspaceId);
      }
      // Don't render an action_result block for pure side-effects /
      // noops; the empty header bar that we used to leave in the
      // chat after a noop command was confusing.
      const text =
        result.kind === 'text'
          ? result.text ?? ''
          : result.kind === 'error'
            ? result.message ?? 'command failed'
            : result.kind === 'session-action'
              ? result.notice ?? ''
              : '';
      const isSilent =
        result.kind === 'noop' ||
        (result.kind === 'session-action' && !text.trim() && !result.notice);
      if (!isSilent) {
        const tone =
          result.kind === 'error'
            ? 'error'
            : result.kind === 'session-action'
              ? 'notice'
              : 'info';
        chatStore.dispatch(workspaceId, {
          type: 'action_result',
          commandName: command.name,
          argsLine: argString,
          tone,
          text,
        });
      }
      onClose();
    } catch (e) {
      chatStore.dispatch(workspaceId, {
        type: 'action_result',
        commandName: command.name,
        argsLine: argString,
        tone: 'error',
        text: toErrorMessage(e),
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
