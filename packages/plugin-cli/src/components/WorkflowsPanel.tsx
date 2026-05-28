import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { WorkflowsView, WorkflowSummaryView } from '@moxxy/sdk';
import { Colors } from '../theme.js';
import { Modal } from './Modal.js';
import { useScrollableList } from './useScrollableList.js';

export interface WorkflowsPanelProps {
  /** Live workflows API stashed on the session, or null when unavailable. */
  readonly view: WorkflowsView | null;
  readonly onClose?: () => void;
}

const NAME_COL = 24;
const SCOPE_COL = 9;
const TRIG_COL = 20;
const WINDOW = 12;

/**
 * Interactive `/workflows` modal. Lists every workflow with its
 * enabled (●) / disabled (○) status; ↑↓ navigate, `d`/space toggle
 * enable/disable, Enter / `r` run the focused workflow, Esc closes
 * (owned by Modal). Run + toggle drive the session's `workflows` view,
 * which is backed by the same engine the agent and scheduler use.
 */
export const WorkflowsPanel: React.FC<WorkflowsPanelProps> = ({ view, onClose }) => {
  const [rows, setRows] = React.useState<ReadonlyArray<WorkflowSummaryView>>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    if (!view) {
      setLoading(false);
      return;
    }
    try {
      const list = await view.list();
      setRows([...list].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setStatus(`failed to load: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [view]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const active = !busy && !!view && rows.length > 0;

  const run = React.useCallback(
    async (wf: WorkflowSummaryView) => {
      if (!view || busy) return;
      if (!wf.enabled) {
        setStatus(`"${wf.name}" is disabled — press d to enable it first.`);
        return;
      }
      setBusy(true);
      setStatus(`running "${wf.name}"…`);
      try {
        const result = await view.run(wf.name);
        const marks = result.steps.map((s) => `${stepMark(s.status)}${s.id}`).join(' ');
        setStatus(result.ok ? `✓ ${wf.name} completed — ${marks}` : `✗ ${wf.name} failed: ${result.error ?? ''} — ${marks}`);
      } catch (err) {
        setStatus(`✗ ${wf.name} errored: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [view, busy, reload],
  );

  const scroll = useScrollableList({
    total: rows.length,
    windowSize: WINDOW,
    isActive: active,
    onSelect: (i) => {
      const wf = rows[i];
      if (wf) void run(wf);
    },
  });

  useInput(
    (input) => {
      const wf = rows[scroll.cursor];
      if (!wf || !view) return;
      if (input === 'd' || input === ' ') {
        setBusy(true);
        setStatus(`${wf.enabled ? 'disabling' : 'enabling'} "${wf.name}"…`);
        void view
          .setEnabled(wf.name, !wf.enabled)
          .then(() => setStatus(`"${wf.name}" ${wf.enabled ? 'disabled ○' : 'enabled ●'}`))
          .catch((err) => setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            setBusy(false);
            void reload();
          });
      } else if (input === 'r') {
        void run(wf);
      }
    },
    { isActive: active },
  );

  const termWidth = process.stdout.columns ?? 80;
  const descWidth = Math.max(16, termWidth - NAME_COL - SCOPE_COL - TRIG_COL - 12);
  const slice = rows.slice(scroll.visible.start, scroll.visible.end);
  const subtitle =
    rows.length === 0 ? 'none' : `${scroll.cursor + 1} of ${rows.length}  ·  ${rows.length} workflow${rows.length === 1 ? '' : 's'}`;
  const hints = 'd enable/disable · Enter/r run · ↑↓ navigate · Esc close';

  return (
    <Modal title="Workflows" subtitle={subtitle} hints={hints} {...(onClose ? { onClose } : {})}>
      {!view ? (
        <Text dimColor>(workflows unavailable in this session)</Text>
      ) : loading ? (
        <Text dimColor>loading…</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>
          (no workflows — ask the agent to “create a workflow that…”, or scaffold one in chat)
        </Text>
      ) : null}
      {scroll.canScrollUp ? <Text dimColor>{`  ↑ ${scroll.offset} more above`}</Text> : null}
      {slice.map((wf, i) => {
        const absoluteIndex = scroll.visible.start + i;
        const focused = absoluteIndex === scroll.cursor;
        return (
          <Box key={wf.name}>
            <Text {...(focused ? {} : { dimColor: true })}>{focused ? '› ' : '  '}</Text>
            <Text color={wf.enabled ? Colors.active : undefined} dimColor={!wf.enabled}>
              {wf.enabled ? '● ' : '○ '}
            </Text>
            <Box width={NAME_COL}>
              <Text bold={focused}>{truncate(wf.name, NAME_COL - 1)}</Text>
            </Box>
            <Box width={SCOPE_COL}>
              <Text dimColor>{wf.scope}</Text>
            </Box>
            <Box width={TRIG_COL}>
              <Text dimColor wrap="truncate">{wf.triggers}</Text>
            </Box>
            <Box width={descWidth}>
              <Text dimColor wrap="truncate">{oneLine(wf.description)}</Text>
            </Box>
          </Box>
        );
      })}
      {scroll.canScrollDown ? (
        <Text dimColor>{`  ↓ ${rows.length - scroll.visible.end} more below`}</Text>
      ) : null}
      {status ? (
        <Box marginTop={1}>
          <Text wrap="truncate-end">{status}</Text>
        </Box>
      ) : null}
    </Modal>
  );
};

function stepMark(status: string): string {
  return status === 'completed' ? '✓' : status === 'skipped' ? '–' : status === 'failed' ? '✗' : '·';
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/  +/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
