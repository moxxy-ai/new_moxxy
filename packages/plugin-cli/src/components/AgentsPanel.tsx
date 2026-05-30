import React from 'react';
import { Box, Text } from 'ink';
import type { AgentDef, MoxxyEvent } from '@moxxy/sdk';
import { formatElapsed } from '@moxxy/chat-model';
import { Colors } from '../theme.js';
import { Modal, type ModalTab } from './Modal.js';
import { useScrollableList } from './useScrollableList.js';

const SUBAGENT_PLUGIN_ID = '@moxxy/subagents';
const WINDOW = 16;

export interface AgentsPanelProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  /**
   * Agent kinds currently in the session's `AgentRegistry`. Rendered
   * under the "Available" tab as a short reference of what the model
   * can pass for `agentType`.
   */
  readonly availableKinds?: ReadonlyArray<AgentDef>;
  /** Called when the user presses Esc inside the modal. */
  readonly onClose?: () => void;
}

interface AgentRecord {
  readonly childSessionId: string;
  readonly label: string;
  readonly startedAtMs: number;
  completedAtMs: number | null;
  state: 'running' | 'done' | 'failed';
  /** All raw activity rows in chronological order. */
  readonly activity: ActivityRow[];
}

interface ActivityRow {
  readonly atMs: number;
  readonly text: string;
  readonly color?: string;
}

type TabId = 'active' | 'available';

/**
 * Read-only modal showing one row per agent activity event so the user
 * can see exactly what each subagent is doing without having to expand
 * a chat scope or read raw event logs. ↑↓ scrolls the unified
 * timeline; ←/→ flips between active timeline and available kinds.
 */
export const AgentsPanel: React.FC<AgentsPanelProps> = ({
  events,
  availableKinds = [],
  onClose,
}) => {
  const agents = collectAgents(events);
  // Build a flat, interleaved timeline (one row per activity event).
  const rows: { agent: AgentRecord; row: ActivityRow }[] = [];
  for (const agent of agents) {
    for (const row of agent.activity) rows.push({ agent, row });
  }
  rows.sort((a, b) => a.row.atMs - b.row.atMs);

  const [activeTab, setActiveTab] = React.useState<TabId>(agents.length > 0 ? 'active' : 'available');

  const scroll = useScrollableList({
    total: rows.length,
    windowSize: WINDOW,
    isActive: activeTab === 'active',
  });

  const tabs: ModalTab[] = [
    { id: 'active', label: `Active (${agents.length})` },
    { id: 'available', label: `Available (${availableKinds.length + 1})` },
  ];

  if (activeTab === 'available') {
    return (
      <Modal
        title="Agents"
        subtitle={`${availableKinds.length + 1} kind${availableKinds.length === 0 ? '' : 's'} installed`}
        tabs={tabs}
        activeTabId={activeTab}
        onTabChange={(id) => setActiveTab(id as TabId)}
        {...(onClose ? { onClose } : {})}
      >
        <KindsList kinds={availableKinds} />
      </Modal>
    );
  }

  if (agents.length === 0) {
    return (
      <Modal
        title="Agents"
        subtitle="no subagents spawned this session"
        tabs={tabs}
        activeTabId={activeTab}
        onTabChange={(id) => setActiveTab(id as TabId)}
        {...(onClose ? { onClose } : {})}
      >
        <Text dimColor>(spawn agents via the `dispatch_agent` tool)</Text>
      </Modal>
    );
  }

  const running = agents.filter((a) => a.state === 'running').length;
  const summary =
    `${agents.length} agent${agents.length === 1 ? '' : 's'}` +
    (running > 0 ? ` · ${running} running` : '');
  const subtitle =
    rows.length > 0 ? `${scroll.cursor + 1} of ${rows.length}  ·  ${summary}` : summary;
  const hints = '↑↓ scroll · PgUp/PgDn fast · g/G top/bottom';
  const slice = rows.slice(scroll.visible.start, scroll.visible.end);
  const labelColWidth = Math.min(
    18,
    agents.reduce((m, a) => Math.max(m, a.label.length), 0) + 2,
  );

  return (
    <Modal
      title="Agents"
      subtitle={subtitle}
      hints={hints}
      tabs={tabs}
      activeTabId={activeTab}
      onTabChange={(id) => setActiveTab(id as TabId)}
      {...(onClose ? { onClose } : {})}
    >
      <Box flexDirection="column" marginBottom={1}>
        {agents.map((a) => (
          <AgentSummary key={a.childSessionId} agent={a} />
        ))}
      </Box>
      {scroll.canScrollUp ? (
        <Text dimColor>{`  ↑ ${scroll.offset} more above`}</Text>
      ) : null}
      {slice.map((entry, i) => {
        const absoluteIndex = scroll.visible.start + i;
        const focused = absoluteIndex === scroll.cursor;
        const time = new Date(entry.row.atMs).toISOString().slice(11, 19);
        return (
          <Box key={`${entry.agent.childSessionId}:${absoluteIndex}`}>
            <Text {...(focused ? {} : { dimColor: true })}>{focused ? '› ' : '  '}</Text>
            <Box width={10}>
              <Text dimColor>{time}</Text>
            </Box>
            <Box width={labelColWidth}>
              <Text dimColor>{truncate(entry.agent.label, labelColWidth - 1)}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text {...(entry.row.color ? { color: entry.row.color } : {})} wrap="truncate">
                {entry.row.text}
              </Text>
            </Box>
          </Box>
        );
      })}
      {scroll.canScrollDown ? (
        <Text dimColor>{`  ↓ ${rows.length - scroll.visible.end} more below`}</Text>
      ) : null}
    </Modal>
  );
};

const KindsList: React.FC<{ kinds: ReadonlyArray<AgentDef> }> = ({ kinds }) => {
  const termWidth = process.stdout.columns ?? 80;
  const nameCol = 20;
  const descCol = Math.max(20, termWidth - nameCol - 12);
  return (
    <Box flexDirection="column">
      <Box marginLeft={2}>
        <Box width={nameCol}>
          <Text bold>default</Text>
        </Box>
        <Box width={descCol}>
          <Text dimColor wrap="truncate">generic tool-use loop (built-in fallback)</Text>
        </Box>
      </Box>
      {kinds.map((k) => (
        <Box key={k.name} marginLeft={2}>
          <Box width={nameCol}>
            <Text bold>{truncate(k.name, nameCol - 1)}</Text>
          </Box>
          <Box width={descCol}>
            <Text dimColor wrap="truncate">{k.description}</Text>
          </Box>
        </Box>
      ))}
      {kinds.length === 0 ? (
        <Box marginLeft={2} marginTop={1}>
          <Text dimColor>install an agent plugin to add kinds</Text>
        </Box>
      ) : null}
    </Box>
  );
};

const AgentSummary: React.FC<{ agent: AgentRecord }> = ({ agent }) => {
  const elapsedMs = (agent.completedAtMs ?? Date.now()) - agent.startedAtMs;
  const elapsed = formatElapsed(elapsedMs);
  const dot =
    agent.state === 'running' ? Colors.busy : agent.state === 'failed' ? Colors.danger : 'blue';
  const toolCount = agent.activity.filter((r) => r.text.startsWith('→ tool ')).length;
  return (
    <Box>
      <Text color={dot}>● </Text>
      <Box width={20}>
        <Text bold>{truncate(agent.label, 19)}</Text>
      </Box>
      <Text dimColor>{`${agent.state} ${elapsed} · ${toolCount} tool call${toolCount === 1 ? '' : 's'}`}</Text>
    </Box>
  );
};

function collectAgents(events: ReadonlyArray<MoxxyEvent>): AgentRecord[] {
  const map = new Map<string, AgentRecord>();
  for (const e of events) {
    if (e.type !== 'plugin_event' || e.pluginId !== SUBAGENT_PLUGIN_ID) continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const childSessionId = String(payload.childSessionId ?? '');
    if (!childSessionId) continue;
    const atMs = new Date(e.ts).getTime();
    if (e.subtype === 'subagent_started') {
      map.set(childSessionId, {
        childSessionId,
        label: String(payload.label ?? 'agent'),
        startedAtMs: atMs,
        completedAtMs: null,
        state: 'running',
        activity: [
          { atMs, text: `started · ${truncate(String(payload.prompt ?? ''), 80)}` },
        ],
      });
      continue;
    }
    const agent = map.get(childSessionId);
    if (!agent) continue;
    if (e.subtype === 'subagent_tool_call') {
      const name = String(payload.name ?? '?');
      const args = summarizeArgs(payload.input);
      agent.activity.push({ atMs, text: `→ tool ${name}(${args})` });
      continue;
    }
    if (e.subtype === 'subagent_tool_result') {
      const ok = payload.ok === true;
      agent.activity.push({
        atMs,
        text: ok ? '  ← ok' : `  ← error: ${truncate(String(payload.error ?? 'unknown'), 80)}`,
        ...(ok ? {} : { color: Colors.danger }),
      });
      continue;
    }
    if (e.subtype === 'subagent_completed') {
      agent.completedAtMs = atMs;
      agent.state = payload.error ? 'failed' : 'done';
      const text = typeof payload.text === 'string' ? oneLine(payload.text) : '';
      agent.activity.push({
        atMs,
        text: `completed · ${truncate(text, 100)}`,
        ...(agent.state === 'failed' ? { color: Colors.danger } : {}),
      });
      continue;
    }
    if (e.subtype === 'subagent_error' || e.subtype === 'subagent_abort') {
      agent.completedAtMs = atMs;
      agent.state = 'failed';
      const reason =
        (typeof payload.message === 'string' && payload.message) ||
        (typeof payload.reason === 'string' && payload.reason) ||
        'aborted';
      agent.activity.push({ atMs, text: `failed: ${reason}`, color: Colors.danger });
      continue;
    }
  }
  return [...map.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
}

function summarizeArgs(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return truncate(oneLine(input), 40);
  if (typeof input !== 'object') return String(input);
  try {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return '';
    return truncate(oneLine(entries.map(([k, v]) => `${k}=${stringifyValue(v)}`).join(', ')), 60);
  } catch {
    return '[…]';
  }
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(truncate(oneLine(v), 24));
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    return truncate(oneLine(JSON.stringify(v)), 24);
  } catch {
    return '[…]';
  }
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/  +/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
