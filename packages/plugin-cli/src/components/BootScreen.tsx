import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { pickExamples, pickSlogan, selectLogo } from '../logo-data.js';
import { Colors, Glyphs } from '../theme.js';
import { LogoLine } from './LogoLine.js';

/**
 * A single boot-progress event. Mirrors `BootStep` from
 * `@moxxy/cli/setup.ts` but without the import dependency — we don't
 * want plugin-cli pulling in the CLI package. Callers translate.
 */
export interface BootEvent {
  /** Stable key matched against the static checklist order. */
  readonly id: BootEventId;
  /** Time the event was recorded, used for the trailing `(Nms)` label. */
  readonly at: number;
  /** Optional detail rendered after the step name (e.g. provider name). */
  readonly detail?: string;
  /** Marks the step as failed — rendered in red, no checklist tick. */
  readonly failed?: boolean;
}

export type BootEventId =
  | 'config-loaded'
  | 'plugins-registered'
  | 'provider-activated'
  | 'prefs-applied'
  | 'skills-loaded'
  | 'init-hooks-done';

interface ChecklistStep {
  readonly id: BootEventId;
  readonly label: string;
}

const STEPS: ReadonlyArray<ChecklistStep> = [
  { id: 'config-loaded', label: 'config loaded' },
  { id: 'plugins-registered', label: 'plugins registered' },
  { id: 'provider-activated', label: 'provider activated' },
  { id: 'prefs-applied', label: 'preferences applied' },
  { id: 'skills-loaded', label: 'skills loaded' },
  { id: 'init-hooks-done', label: 'onInit hooks fired' },
];

export interface BootScreenProps {
  /**
   * Ordered list of events that have fired so far. Steps not yet
   * represented in the list render with the pending glyph.
   */
  readonly events: ReadonlyArray<BootEvent>;
  /**
   * When the bootstrap process started; each completed step shows
   * `(<elapsed>ms)` measured from this anchor.
   */
  readonly startedAt: number;
  /**
   * Fatal error from boot. Renders as a centered red block; the
   * failing step's label surfaces above the message.
   */
  readonly error?: { readonly failedStep?: BootEventId; readonly message: string };
}

// Number of example prompts to surface on the boot screen. Two keeps
// the panel tight while still hinting at breadth (the pool in
// `logo-data.ts` spans coding, automation, webhooks, memory, …).
const READY_EXAMPLE_COUNT = 2;

/**
 * Full-screen boot panel: centered logo + slogan, with the live
 * checklist replaced by terse output:
 *   - during boot: nothing (just logo + slogan)
 *   - on error: red error block + the failing step
 *   - on ready: one short suggestion with the command token in white
 *
 * Stays mounted until the InteractiveSession flips to `phase === 'ready'`,
 * at which point the parent swaps in the steady-state layout.
 */
export const BootScreen: React.FC<BootScreenProps> = ({ events, startedAt, error }) => {
  void startedAt;
  const slogan = useMemo(() => pickSlogan(), []);
  // `pickExamples` is itself process-cached, so re-renders never
  // shuffle the picks; the useMemo is for clarity.
  const examples = useMemo(() => pickExamples(READY_EXAMPLE_COUNT), []);
  const width = process.stdout.columns ?? 80;
  const { lines } = selectLogo(width);

  const seen = new Map<BootEventId, BootEvent>();
  for (const e of events) seen.set(e.id, e);
  const failedStep = error?.failedStep
    ? STEPS.find((s) => s.id === error.failedStep) ?? null
    : null;
  const ready = !error && STEPS.every((s) => seen.has(s.id));

  return (
    <Box flexDirection="column" alignItems="center" width="100%" marginTop={1}>
      <Box flexDirection="column" alignItems="center">
        {lines.map((line, i) => (
          <LogoLine key={i} text={line} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic>{slogan}</Text>
      </Box>

      {error ? (
        <Box flexDirection="column" marginTop={2} alignItems="center">
          <Text color={Colors.danger}>
            {Glyphs.filled} {failedStep?.label ?? 'boot failed'}
          </Text>
          <Text color={Colors.danger}>{error.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>Run </Text>
            <Text>moxxy init</Text>
            <Text dimColor> in another terminal, then relaunch.</Text>
          </Box>
        </Box>
      ) : ready ? (
        <Box flexDirection="column" alignItems="flex-start" marginTop={2}>
          {examples.map((example, i) => (
            <Box key={i}>
              <Text dimColor>{'›  '}</Text>
              <Text>{example}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};
