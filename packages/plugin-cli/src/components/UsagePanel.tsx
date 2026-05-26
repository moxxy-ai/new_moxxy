import React from 'react';
import { Box, Text, useInput } from 'ink';
import { summarizeSessionTokensFromEvents, type MoxxyEvent } from '@moxxy/sdk';
import { Colors } from '../theme.js';
import { Modal } from './Modal.js';

export interface UsagePanelProps {
  readonly events: ReadonlyArray<MoxxyEvent>;
  /** Active model's context window, for the live context-fill bar. */
  readonly contextWindow?: number | null;
  /** Current estimated context tokens (what the next call would send). */
  readonly contextTokens?: number | null;
  readonly onClose?: () => void;
}

const BAR_WIDTH = 22;
const LABEL_COL = 14;
const SPARKS = '▁▂▃▄▅▆▇█';

function clamp(f: number): number {
  return Math.max(0, Math.min(1, f));
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/**
 * A bar where only the FILLED portion carries the accent color and the empty
 * track is dim — so a 0% bar reads as empty, not as a solid colored block
 * (the original bug where a 0% "cache read" bar looked full).
 */
const Bar: React.FC<{ frac: number; color?: string; width?: number }> = ({
  frac,
  color,
  width = BAR_WIDTH,
}) => {
  const filled = Math.round(clamp(frac) * width);
  return (
    <Text>
      <Text {...(color ? { color } : {})}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(width - filled)}</Text>
    </Text>
  );
};

/** One row of the prompt-composition breakdown: label · bar · % · value. */
const CompRow: React.FC<{ label: string; frac: number; value: number; color?: string }> = ({
  label,
  frac,
  value,
  color,
}) => (
  <Box>
    <Box width={LABEL_COL}>
      <Text dimColor>{label}</Text>
    </Box>
    <Bar frac={frac} color={color} />
    <Text>{`  ${pct(frac).padStart(4)}`}</Text>
    <Text dimColor>{`  ${fmt(value)}`}</Text>
  </Box>
);

/** A labelled metric bar (cache hit, context fill). */
const MetricRow: React.FC<{
  label: string;
  frac: number;
  color?: string;
  suffix?: string;
}> = ({ label, frac, color, suffix }) => (
  <Box>
    <Box width={LABEL_COL}>
      <Text bold>{label}</Text>
    </Box>
    <Bar frac={frac} color={color} />
    <Text>{`  ${pct(frac).padStart(4)}`}</Text>
    {suffix ? <Text dimColor>{`  ${suffix}`}</Text> : null}
  </Box>
);

/** Per-call prompt sizes (input + cache read + cache write) in call order. */
function perCallPrompt(events: ReadonlyArray<MoxxyEvent>): number[] {
  const out: number[] = [];
  for (const e of events) {
    if (e.type !== 'provider_response') continue;
    if (
      e.inputTokens === undefined &&
      e.cacheReadTokens === undefined &&
      e.cacheCreationTokens === undefined
    ) {
      continue;
    }
    out.push((e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0));
  }
  return out;
}

/** Render a sparkline of per-call prompt sizes, scaled to the series max. */
function sparkline(series: number[], maxCols = 48): string {
  if (series.length === 0) return '';
  const tail = series.slice(-maxCols);
  const max = Math.max(...tail, 1);
  return tail
    .map((v) => SPARKS[Math.min(SPARKS.length - 1, Math.round((v / max) * (SPARKS.length - 1)))])
    .join('');
}

/**
 * `/usage` modal — cumulative session token accounting. Bars show prompt
 * composition (cache read vs fresh vs cache write), cache hit rate, input-cost
 * savings, live context fill, and a per-call sparkline that makes growth
 * (quadratic) vs bounded (flat) visible at a glance. Esc closes (global Esc is
 * suppressed while an overlay is open, so we capture it here).
 */
export const UsagePanel: React.FC<UsagePanelProps> = ({
  events,
  contextWindow,
  contextTokens,
  onClose,
}) => {
  useInput((_input, key) => {
    if (key.escape) onClose?.();
  });

  const s = React.useMemo(() => summarizeSessionTokensFromEvents(events), [events]);
  const series = React.useMemo(() => perCallPrompt(events), [events]);

  if (s.calls === 0) {
    return (
      <Modal title="Usage" subtitle="no provider calls yet" hints="Esc close">
        <Text dimColor>(no token usage recorded — run a turn, then reopen /usage)</Text>
      </Modal>
    );
  }

  const freshFrac = s.totalPrompt > 0 ? s.totalInput / s.totalPrompt : 0;
  const readFrac = s.totalPrompt > 0 ? s.totalCacheRead / s.totalPrompt : 0;
  const writeFrac = s.totalPrompt > 0 ? s.totalCacheCreation / s.totalPrompt : 0;

  const ctxFrac =
    contextWindow && contextTokens != null && contextWindow > 0
      ? contextTokens / contextWindow
      : null;
  const ctxColor =
    ctxFrac == null ? undefined : ctxFrac >= 0.85 ? Colors.danger : ctxFrac >= 0.6 ? Colors.busy : Colors.active;

  const saved = s.savedRatio;
  const trend =
    series.length >= 4 ? (series[series.length - 1]! > series[0]! * 1.5 ? 'growing' : 'bounded') : null;

  const subtitle = `${s.calls} calls   ·   ${fmt(s.totalPrompt)} prompt   ·   ${fmt(s.totalOutput)} output`;

  return (
    <Modal title="Usage" subtitle={subtitle} hints="Esc close">
      <Text bold>Prompt composition</Text>
      <CompRow label="cache read" frac={readFrac} value={s.totalCacheRead} color={Colors.active} />
      <CompRow label="fresh input" frac={freshFrac} value={s.totalInput} />
      <CompRow label="cache write" frac={writeFrac} value={s.totalCacheCreation} color={Colors.busy} />

      <Box marginTop={1} flexDirection="column">
        <MetricRow
          label="Cache hit"
          frac={s.cacheHitRate}
          color={s.cacheHitRate >= 0.5 ? Colors.active : Colors.busy}
        />
        {ctxFrac != null ? (
          <MetricRow
            label="Context fill"
            frac={ctxFrac}
            color={ctxColor}
            suffix={`${fmt(contextTokens ?? 0)} / ${fmt(contextWindow ?? 0)}`}
          />
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Box width={LABEL_COL}>
          <Text bold>Input cost</Text>
        </Box>
        <Text>{fmt(s.billedInputEq)} billed-eq</Text>
        {saved > 0.005 ? (
          <Text color={Colors.active} bold>{`   saved ${pct(saved)}`}</Text>
        ) : (
          <Text dimColor>{'   no cache savings yet'}</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text bold>Per-call prompt </Text>
          <Text dimColor>{`peak ${fmt(Math.max(...series, 0))}`}</Text>
        </Box>
        <Box>
          <Text>{sparkline(series)}</Text>
          {trend ? (
            <Text color={trend === 'growing' ? Colors.busy : Colors.active}>
              {trend === 'growing' ? '  ↑ growing' : '  ≈ bounded'}
            </Text>
          ) : null}
        </Box>
      </Box>

      {!s.cacheEffective ? (
        <Box marginTop={1}>
          <Text color={Colors.danger}>
            {'⚠ cache ineffective — writing cache but not reading it back (prefix likely unstable)'}
          </Text>
        </Box>
      ) : null}
    </Modal>
  );
};
