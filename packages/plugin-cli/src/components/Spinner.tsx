import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface SpinnerProps {
  readonly label?: string;
  readonly color?: string;
  /** Frame interval in ms; defaults to 80. */
  readonly intervalMs?: number;
}

/**
 * Braille-dot animated spinner. Used by the TUI's "thinking…" state and
 * anywhere else the wizard waits on async work.
 *
 * Pure Ink — no extra deps. The interval is owned by the component so it
 * stops when the spinner unmounts.
 */
export const Spinner: React.FC<SpinnerProps> = ({ label, color = 'cyan', intervalMs = 80 }) => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  const glyph = FRAMES[frame]!;
  return (
    <Text color={color}>
      {glyph}
      {label ? ` ${label}` : ''}
    </Text>
  );
};
