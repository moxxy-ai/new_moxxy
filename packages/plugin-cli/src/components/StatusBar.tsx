import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { RainbowText } from './RainbowText.js';
import { Spinner } from './Spinner.js';

export interface StatusBarProps {
  readonly provider: string;
  readonly model: string;
  /** Approximate input tokens consumed so far. */
  readonly contextUsed?: number;
  /** Active model's context window size. Required for the percentage. */
  readonly contextWindow?: number;
  /** Auto-approve mode active — animated rainbow badge on the right. */
  readonly yolo?: boolean;
  /**
   * MCP attach summary: how many configured-and-enabled servers are
   * currently live. Shown as `mcp <connected>/<enabled>` between the
   * model name and the context meter. Hidden when no servers configured.
   */
  readonly mcp?: { readonly connected: number; readonly enabled: number };
  /**
   * Active turn indicator. When `busyStartedAt` is set, the bar shows a
   * spinner + elapsed time on the right edge so the user always knows
   * the model is working — replaces the standalone spinner that used to
   * live below the chat scrollback.
   */
  readonly busyStartedAt?: number | null;
  /**
   * Number of user messages queued (typed while the model was busy).
   * Shown as `↑ N queued` when > 0 so the user can see their backlog
   * without running `/queue`.
   */
  readonly queueCount?: number;
}

/**
 * Row below the prompt input. Left side: provider chip + model name.
 * Right side: context-window meter and, when yolo mode is on, an
 * animated rainbow "YOLO MODE" indicator so it's loud enough to remind
 * the user that tool calls are being auto-approved.
 */
export const StatusBar: React.FC<StatusBarProps> = ({
  provider,
  model,
  contextUsed,
  contextWindow,
  yolo,
  mcp,
  busyStartedAt,
  queueCount,
}) => {
  const showMcp = !!(mcp && mcp.enabled > 0);
  const showContext = !!contextWindow;
  const showBusy = busyStartedAt != null;
  const showQueue = (queueCount ?? 0) > 0;
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text backgroundColor="magenta" color="white" bold>{` ${provider} `}</Text>
        <Text dimColor>{`  ${model}`}</Text>
      </Box>
      <Box>
        {showBusy ? <ThinkingIndicator startedAt={busyStartedAt!} /> : null}
        {showBusy && showQueue ? <Separator /> : null}
        {showQueue ? <QueueIndicator count={queueCount!} /> : null}
        {(showBusy || showQueue) && showMcp ? <Separator /> : null}
        {showMcp ? <McpChip mcp={mcp!} /> : null}
        {(showBusy || showQueue || showMcp) && showContext ? <Separator /> : null}
        {showContext ? <ContextMeter used={contextUsed ?? 0} total={contextWindow!} /> : null}
        {yolo ? (
          <>
            {showBusy || showQueue || showMcp || showContext ? <Text>  </Text> : null}
            <RainbowText bold>YOLO MODE</RainbowText>
          </>
        ) : null}
      </Box>
    </Box>
  );
};

const QueueIndicator: React.FC<{ count: number }> = ({ count }) => (
  <Box>
    <Text dimColor>↑ </Text>
    <Text>{count}</Text>
    <Text dimColor>{` queued`}</Text>
  </Box>
);

const Separator: React.FC = () => <Text dimColor>{'  ·  '}</Text>;

/**
 * Spinner + elapsed-time readout while a turn is in flight. The clock
 * ticks once per second so a slow turn visibly progresses; sub-second
 * resolution would just churn the render loop for no visible benefit.
 */
const ThinkingIndicator: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedMs = Math.max(0, now - startedAt);
  return (
    <Box>
      <Spinner color="yellow" />
      <Text color="yellow">{` thinking `}</Text>
      <Text dimColor>{formatElapsed(elapsedMs)}</Text>
      <Text dimColor>{'  (esc)'}</Text>
    </Box>
  );
};

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec.toString().padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin.toString().padStart(2, '0')}m`;
}

const McpChip: React.FC<{ mcp: { connected: number; enabled: number } }> = ({ mcp }) => (
  <Box>
    <Text dimColor>mcp </Text>
    <Text>{`${mcp.connected}/${mcp.enabled}`}</Text>
  </Box>
);

// Visual width of the context-usage bar. Picked to stay tight on the
// right edge of the status bar while still showing meaningful
// resolution at low usage (1 cell ≈ 10%).
const CONTEXT_BAR_WIDTH = 10;

const ContextMeter: React.FC<{ used: number; total: number }> = ({ used, total }) => {
  const pct = Math.min(100, Math.round((used / total) * 100));
  // Reserve the colour for "you're running out of room" — neutral bar
  // until 60%, yellow at 60–84%, red at 85%+. Matches the previous
  // numeric meter's escalation thresholds.
  const color = pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : undefined;
  const filled = Math.round((pct / 100) * CONTEXT_BAR_WIDTH);
  const empty = CONTEXT_BAR_WIDTH - filled;
  return (
    <Box>
      <Text dimColor>context </Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text color={color}>{` ${pct}%`}</Text>
    </Box>
  );
};
