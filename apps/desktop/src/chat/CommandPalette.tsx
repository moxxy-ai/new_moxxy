/**
 * Public entry for the actions palette. The implementation is split
 * under `command-palette/` (container + args form + the pure stepper /
 * quoting helpers); this barrel keeps the historical import path
 * (`./CommandPalette`) stable for the Composer and preserves the
 * original named exports (`stepsForCommand`, the `ArgStep` type).
 */

export { CommandPalette } from './command-palette/CommandPalette';
export { stepsForCommand } from './command-palette/steppers';
export type { ArgStep } from './command-palette/types';
