import type { PermissionResolver } from './permission.js';
import type { MoxxyRequirement } from './requirements.js';

/**
 * A Channel is a bidirectional surface that drives a Session: it feeds user
 * prompts in, renders assistant chunks + tool activity out, and implements a
 * PermissionResolver so it can interrupt tool execution to ask the user.
 *
 * The TUI (Ink) and Telegram are both Channels. Future Slack / Discord / HTTP
 * channels implement this same interface so the moxxy CLI binary (or any
 * embedded consumer) can dispatch to them uniformly.
 *
 * The generic `TStartOpts` is the concrete options shape a given channel
 * accepts.
 */
export interface Channel<TStartOpts = unknown> {
  /** Stable name (lowercase, single word). Used by dispatchers to look up by string. */
  readonly name: string;

  /** The PermissionResolver this channel installs on the session. */
  readonly permissionResolver: PermissionResolver;

  /**
   * Begin running the channel. Returns a handle whose `running` promise
   * resolves when the channel exits gracefully.
   */
  start(opts: TStartOpts): Promise<ChannelHandle>;
}

export interface ChannelHandle {
  /**
   * Resolves when the channel exits cleanly (user quit, SIGINT caught,
   * upstream disconnected). Rejects on fatal error.
   */
  readonly running: Promise<void>;

  /** Request graceful shutdown. Implementations should abort any in-flight work. */
  stop(reason?: string): Promise<void>;
}

/** Common base shape for channel start options. */
export interface ChannelStartOptsBase {
  readonly model?: string;
  readonly systemPrompt?: string;
}

/**
 * Standard dependencies that a channel factory receives. Channels pick what
 * they need from this bag. Production CLI populates all of these; tests may
 * pass only a subset.
 */
export interface ChannelFactoryDeps {
  /** Working directory for the channel (matches the Session's cwd). */
  readonly cwd: string;
  /** Optional encrypted-secret store (typed loosely — plugins import the concrete VaultStore type when needed). */
  readonly vault?: unknown;
  /** Optional structured logger. */
  readonly logger?: {
    debug?(msg: string, meta?: Record<string, unknown>): void;
    info?(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
    error?(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Free-form per-channel overrides forwarded from the CLI invocation. */
  readonly options?: Record<string, unknown>;
}

/**
 * A registered, named factory for a Channel. Plugins contribute these via
 * `definePlugin({ channels: [defineChannel(...)] })`. The CLI looks up by name
 * and dispatches: `moxxy <name>` calls `def.create(deps).start({session,...})`.
 */
export interface ChannelDef<TStartOpts = unknown> {
  readonly name: string;
  readonly description: string;
  readonly requirements?: ReadonlyArray<MoxxyRequirement>;
  create(deps: ChannelFactoryDeps): Channel<TStartOpts>;
  /**
   * Optional runtime gate. Lets a channel declare "I can only run if these
   * preconditions are met" (e.g., Telegram needs a token in the vault; TUI
   * needs a TTY). The dispatcher uses this to filter the visible channel list
   * and to give the user a helpful error before construction.
   *
   * Default: always available.
   */
  isAvailable?(deps: ChannelFactoryDeps): Promise<ChannelAvailability>;
  /**
   * One-shot subcommands the channel exposes. Routed as
   * `moxxy channels <name> <subcommand>` by the CLI. Use this for
   * channel-specific maintenance commands that don't need to run the channel
   * (e.g., Telegram's `unpair`, `status`) — or that want to nudge a start with
   * a flag (e.g., `pair` -> start with options.pair=true).
   */
  readonly subcommands?: Readonly<Record<string, ChannelSubcommand>>;
}

export interface ChannelAvailability {
  readonly ok: boolean;
  /** Human-readable explanation when ok=false. Shown by `moxxy channels list`. */
  readonly reason?: string;
}

/** Positional + flag args handed to a channel subcommand by the CLI. */
export interface ChannelCommandArgs {
  readonly positional: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | boolean | undefined>>;
}

/**
 * Context handed to a channel subcommand. The CLI builds `deps` exactly like
 * it does for `Channel.create()` so subcommands can:
 *  - inspect `deps.vault` for one-shot ops (unpair, status)
 *  - mutate `deps.options` and call `startChannel()` to launch the channel
 *    with extra start opts (e.g., pair=true)
 */
export interface ChannelSubcommandContext {
  readonly deps: ChannelFactoryDeps;
  readonly args: ChannelCommandArgs;
  /**
   * Boot a session and run the channel by name. Returns the process exit code
   * (0 on clean shutdown). Subcommands that want to "start with twist" call
   * this with overrides instead of duplicating the start-loop themselves.
   */
  startChannel(options?: Readonly<Record<string, unknown>>): Promise<number>;
}

export interface ChannelSubcommand {
  readonly description: string;
  run(ctx: ChannelSubcommandContext): Promise<number>;
}

/**
 * Read-only registry of channels available in a Session. Implementation lives
 * in @moxxy/core.
 */
export interface ChannelRegistry {
  list(): ReadonlyArray<ChannelDef>;
  get(name: string): ChannelDef | undefined;
  has(name: string): boolean;
  /**
   * Returns every channel paired with its current availability. Channels
   * without an `isAvailable` hook are treated as `{ok: true}`.
   */
  listWithAvailability(deps: ChannelFactoryDeps): Promise<ReadonlyArray<{
    readonly def: ChannelDef;
    readonly availability: ChannelAvailability;
  }>>;
}
