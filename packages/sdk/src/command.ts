/**
 * Commands — channel-agnostic actions the user can trigger with a
 * `/<name>` prefix. Live on the Session's CommandRegistry so every
 * channel (TUI slash menu, Telegram bot command, future HTTP `/cmd`
 * endpoint) reads the same set. Plugins contribute commands via
 * `PluginSpec.commands`.
 *
 * Why a registry instead of channel-local switch statements:
 * /info works the same way whether the user types it in the TUI or
 * sends `/info` to the Telegram bot. The handler returns a typed
 * CommandOutput; each channel decides how to render it (TUI as a
 * systemNotice, Telegram as a chat message, HTTP as JSON).
 */

import type { SessionId } from './ids.js';

export interface CommandDef {
  /** Name without the leading `/`. */
  readonly name: string;
  /** One-line description shown in `/help` and channel pickers. */
  readonly description: string;
  /** Alternative names (without leading `/`). */
  readonly aliases?: ReadonlyArray<string>;
  /**
   * When set, the command only surfaces in these channels by name
   * (e.g. `['tui']` for an overlay-style command that wouldn't make
   * sense in Telegram). Omit for "all channels".
   */
  readonly channels?: ReadonlyArray<string>;
  /** Optional short status shown by interactive channels while the command runs. */
  readonly pendingNotice?: string;
  /** Handler invoked by the channel. Receives raw args after the name. */
  readonly handler: (ctx: CommandContext) => Promise<CommandOutput> | CommandOutput;
}

export interface CommandContext {
  /** Channel that invoked the command — `'tui'`, `'telegram'`, etc. */
  readonly channel: string;
  /** Session id the command runs against. */
  readonly sessionId: SessionId;
  /** Raw text after the command name (`"hello"` for `/echo hello`). */
  readonly args: string;
  /**
   * The active Session. Loosely typed (`unknown`) so the SDK doesn't
   * pull in core; handlers cast to `Session` from `@moxxy/core` when
   * they need registries. The plugin host always passes the real
   * Session here.
   */
  readonly session: unknown;
}

/**
 * What a command returns. Channels pick the appropriate UI for each
 * variant. New variants are additive — channels that don't know a
 * variant fall back to rendering its `text` field if present.
 */
export type CommandOutput =
  /** Simple text response. Every channel can render this. */
  | { readonly kind: 'text'; readonly text: string }
  /**
   * Structural action that the host channel performs in its UI
   * (`clear`/`new`/`exit`). Carries an optional message the channel
   * may surface alongside the action.
   */
  | {
      readonly kind: 'session-action';
      readonly action: 'new' | 'clear' | 'exit';
      readonly notice?: string;
    }
  /** No-op (handler decided nothing needs surfacing). */
  | { readonly kind: 'noop' }
  /**
   * Handler errored. Channels render this distinctly (red text, etc.).
   * Use this instead of throwing so the command pipeline never
   * crashes the channel.
   */
  | { readonly kind: 'error'; readonly message: string };

export type CommandHandlerResult = CommandOutput;
