/**
 * Shape types for the actions palette — the runner's `command.run`
 * capabilities (CommandInfo) plus the per-action arg schema (ArgStep)
 * the palette renders into a form.
 */

export interface CommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly channels?: ReadonlyArray<string>;
  readonly pendingNotice?: string;
}

export interface SessionInfoSlice {
  readonly commands?: ReadonlyArray<CommandInfo>;
}

export interface ArgStep {
  readonly label: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly multiline?: boolean;
  readonly help?: string;
}
