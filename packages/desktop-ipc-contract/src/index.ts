/**
 * Shared IPC contract — every channel name and payload shape used
 * across the Electron main / preload / renderer boundary lives here.
 * The preload exposes `window.moxxy` whose surface is generated from
 * these types; the renderer uses `window.moxxy` exclusively (no raw
 * `electron.ipcRenderer.invoke` calls leak through).
 *
 * Keeping this in one file means a new feature is one shape addition
 * here + a main-process handler + a renderer call — no string typos
 * across three places.
 */

import type {
  MoxxyEvent,
  SessionInfo,
  ApprovalRequest,
  ApprovalOption,
  PermissionMode,
} from '@moxxy/sdk';

export type { ApprovalRequest, ApprovalOption, PermissionMode };

// ---------- Interactive ask (permission / approval prompts) ---------------

/**
 * A decision the runner needs from the user, forwarded from the connected
 * session to the renderer. `kind: 'permission'` gates a tool call;
 * `kind: 'approval'` is a loop-strategy confirmation (plan-execute, BMAD, …).
 * The renderer renders a bottom sheet and replies with {@link AskResponse}
 * keyed by `requestId`.
 */
export interface AskRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly kind: 'permission' | 'approval';
  /** Present for `kind: 'permission'`. */
  readonly tool?: { readonly name: string; readonly input: unknown; readonly description?: string };
  /** Present for `kind: 'approval'`. */
  readonly approval?: ApprovalRequest;
}

export interface AskResponse {
  /** Permission verdict (kind: 'permission'). */
  readonly mode?: PermissionMode;
  /** Chosen approval option id (kind: 'approval'). */
  readonly optionId?: string;
  /** Free-text follow-up when the chosen approval option requested it. */
  readonly text?: string;
}

export type { SessionInfo };
// `validateIpcInput` / `ipcInputSchemas` are exposed via the
// `@moxxy/desktop-ipc-contract/validation` subpath (not re-exported here)
// so the contract types stay a leaf — validation depends on the types,
// not the other way around.

// ---------- Connection lifecycle -------------------------------------------

/**
 * State machine the main process broadcasts as it tries to reach a
 * working moxxy runner. The renderer reads the latest phase and
 * renders the right surface.
 */
export type ConnectionPhase =
  | { phase: 'idle' }
  | { phase: 'resolving-cli' }
  | { phase: 'cli-missing'; hint: string }
  | { phase: 'spawning'; cliPath: string; socket: string; pid?: number }
  | { phase: 'adopting'; socket: string }
  | { phase: 'attaching'; socket: string }
  | {
      phase: 'connected';
      socket: string;
      sessionId: string;
      activeProvider: string | null;
      activeMode: string | null;
    }
  | {
      phase: 'reconnecting';
      reason: string;
      attempt: number;
    }
  | { phase: 'failed'; error: string; hint?: string };

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  cliPath: string | null;
  attempts: number;
  log: ReadonlyArray<{ stream: 'stdout' | 'stderr'; line: string }>;
}

// ---------- Onboarding -----------------------------------------------------

/**
 * Provider-key + config state. The renderer flips to the init
 * wizard whenever `needsSetup` is true after a successful connect.
 */
export interface OnboardingStatus {
  cliInstalled: boolean;
  cliPath: string | null;
  hasProvider: boolean;
  /** ProviderName from `~/.moxxy/preferences.json`. */
  activeProvider: string | null;
}

/**
 * Node.js detection snapshot — drives the first onboarding step
 * (we can't install or run moxxy without Node).
 */
export interface NodeProbe {
  installed: boolean;
  version: string | null;
  bin: string | null;
}

/** One line of streamed install output. */
export interface InstallProgressLine {
  line: string;
}

// ---------- Desktop preferences (first-run + auth state) -------------------

export interface DesktopPrefs {
  onboardingComplete: boolean;
  clerkUserId: string | null;
  clerkDisplayName: string | null;
  signedInAt: number | null;
  version: 1;
}

// ---------- Workflows ------------------------------------------------------

export interface WorkflowSummary {
  name: string;
  description: string;
  enabled: boolean;
  scope: string;
  steps: number;
  triggers: string;
}

export interface WorkflowRun {
  ok: boolean;
  output: string;
  error?: string;
  steps: ReadonlyArray<{ id: string; status: string; error?: string }>;
}

// ---------- Settings -------------------------------------------------------

export interface ProviderEntry {
  name: string;
  /** True when the runner has activated this provider (credentials
   *  resolved). False = entry exists but key is missing or invalid. */
  ready: boolean;
}

export interface McpServerEntry {
  name: string;
  enabled: boolean;
  connected: boolean;
}

export interface VaultEntryName {
  name: string;
}

export interface SkillFile {
  name: string;
  /** True if the file is editable (lives under ~/.moxxy/skills/). */
  editable: boolean;
  /** First line of the skill's frontmatter `description`, when present. */
  description?: string;
}

// ---------- Desks ---------------------------------------------------------

export interface Desk {
  id: string;
  name: string;
  cwd: string;
  color: string;
  createdAt: number;
}

export interface DesksOverview {
  desks: Desk[];
  activeId: string | null;
}

// ---------- Chat -----------------------------------------------------------

export interface PromptAttachment {
  /** Local-file path the agent should be able to read. Absolute when
   *  picked from the workspace file tree, native-picker path when
   *  picked via Attach. */
  readonly path: string;
  /** Display name (basename of `path`). */
  readonly name: string;
}

export interface RunTurnArgs {
  prompt: string;
  model?: string;
  attachments?: ReadonlyArray<PromptAttachment>;
}

export interface RunTurnResult {
  turnId: string;
}

// ---------- Events the renderer subscribes to ------------------------------

/**
 * Channel names. Centralized so a typo is caught at the type level
 * (the preload's `subscribe(channel, handler)` is generic over this
 * map).
 */
export interface IpcEvents {
  /** Phase of the supervisor for `workspaceId`. The renderer's
   *  ConnectionStore keeps one phase per workspace; the foreground UI
   *  reads only the active workspace's. */
  'connection.changed': { workspaceId: string; phase: ConnectionPhase };
  /** Runner event tagged with the workspace it came from so the
   *  renderer can dispatch into the right per-workspace chat state. */
  'runner.event': { workspaceId: string; event: MoxxyEvent };
  'runner.turn.complete': {
    workspaceId: string;
    turnId: string;
    error: string | null;
  };
  /** Streamed during `onboarding.installMoxxyCli`. One event per
   *  stdout/stderr line; the invoke() also returns the final exit
   *  code so callers can short-circuit on success. */
  'onboarding.install.progress': string;
  /** The runner needs a permission/approval decision — the renderer
   *  shows a bottom sheet and replies via `ask.respond`. */
  'ask.request': AskRequest;
}

// ---------- Invokable commands (renderer → main) --------------------------

/**
 * Every invokable IPC command the renderer can call. The preload
 * surface is built mechanically from this; misnaming a command in the
 * renderer is a type error rather than a silent runtime failure.
 */
export interface IpcCommands {
  /** Reply to an `ask.request` (permission/approval bottom sheet). */
  'ask.respond': (args: { requestId: string; response: AskResponse }) => Promise<void>;
  /** Returns the snapshot for the given workspace. Defaults to the
   *  pool's active workspace. */
  'connection.snapshot': (args?: { workspaceId?: string }) => Promise<
    ConnectionSnapshot & { workspaceId: string }
  >;
  /** Snapshot every supervised workspace (active + background). Used
   *  on cold start so the renderer learns about running background
   *  workspaces without waiting for events. */
  'connection.snapshotAll': () => Promise<
    ReadonlyArray<ConnectionSnapshot & { workspaceId: string }>
  >;
  /** Currently foregrounded workspace id, or null if no workspace is
   *  bound. */
  'connection.activeWorkspace': () => Promise<string | null>;
  /** Kick the supervisor out of failed / reconnecting back into the
   *  resolution loop. */
  'connection.retry': (args?: { workspaceId?: string }) => Promise<void>;

  /** Version + on-disk path of the moxxy CLI the desktop is currently
   *  running. Either field may be null if it can't be resolved. */
  'app.cliInfo': () => Promise<{ version: string | null; path: string | null }>;
  /** Install the latest published `@moxxy/cli` into the writable
   *  userData copy, then restart every runner so the new binary is
   *  used immediately. Streams npm output via
   *  `onboarding.install.progress`. Returns the exit code (0 = ok) and
   *  the post-update version. */
  'app.updateCli': () => Promise<{ code: number; version: string | null }>;

  'onboarding.status': () => Promise<OnboardingStatus>;
  /** Probe Node.js — used by the first wizard step before we offer
   *  the install. */
  'onboarding.probeNode': () => Promise<NodeProbe>;
  /** Run `npm install -g @moxxy/cli`. Streams progress via
   *  `onboarding.install.progress`. Returns the exit code (0 = ok). */
  'onboarding.installMoxxyCli': () => Promise<number>;
  /** Open a URL in the user's default browser. Used for the Node.js
   *  install fallback (we never pretend to install Node ourselves). */
  'onboarding.openExternal': (args: { url: string }) => Promise<void>;
  /** Run `moxxy vault set <NAME>_API_KEY` with the given secret piped
   *  on stdin, then call `provider.setActive` on the running session
   *  so the next turn picks it up without a relaunch. */
  'onboarding.saveProviderKey': (args: { provider: string; secret: string }) => Promise<void>;
  /** Returns how a provider authenticates so the wizard can pick the
   *  right UI affordance: a key field vs an OAuth button. */
  'onboarding.providerAuthKind': (args: { provider: string }) => Promise<'oauth' | 'api-key'>;
  /** Spawn `moxxy login <provider>`. The CLI opens the browser and
   *  runs the OAuth flow. stdout/stderr are streamed via
   *  `onboarding.install.progress`. Resolves with the exit code. */
  'onboarding.runProviderLogin': (args: { provider: string }) => Promise<number>;

  'desks.list': () => Promise<DesksOverview>;
  'desks.create': (args: { name: string; cwd: string }) => Promise<Desk>;
  'desks.remove': (args: { id: string }) => Promise<void>;
  'desks.setActive': (args: { id: string }) => Promise<void>;
  'desks.rename': (args: { id: string; name: string }) => Promise<Desk>;
  /** Open a native folder picker; resolves to the absolute path or null
   *  if the user cancelled. */
  'desks.pickFolder': () => Promise<string | null>;

  /** Returns the runner's SessionInfo snapshot for the workspace.
   *  Defaults to the active workspace. */
  'session.info': (args?: { workspaceId?: string }) => Promise<SessionInfo | null>;
  /** Issue a new turn. Defaults to the active workspace; pass a
   *  workspaceId to start a turn in a background workspace. Events
   *  stream back via 'runner.event' tagged with the same id. */
  'session.runTurn': (
    args: RunTurnArgs & { workspaceId?: string },
  ) => Promise<RunTurnResult>;
  /** Abort the named turn. Best-effort. */
  'session.abortTurn': (args: {
    workspaceId?: string;
    turnId: string;
  }) => Promise<void>;
  /** Switch the active provider. The vault must already hold the
   *  matching credential. */
  'session.setProvider': (args: {
    workspaceId?: string;
    provider: string;
  }) => Promise<void>;
  /** Switch the active mode. */
  'session.setMode': (args: { workspaceId?: string; mode: string }) => Promise<void>;
  /** Run a slash command on the workspace's runner. The runner returns
   *  a CommandOutput (text / session-action / noop / error) which the
   *  caller renders inline in the transcript. */
  'session.runCommand': (args: {
    workspaceId?: string;
    name: string;
    args: string;
  }) => Promise<{
    readonly kind: 'text' | 'session-action' | 'noop' | 'error';
    readonly text?: string;
    readonly action?: 'new' | 'clear' | 'exit';
    readonly notice?: string;
    readonly message?: string;
  }>;
  /** True when the runner has an active transcriber plugin. UI uses
   *  this to enable/disable the mic button. */
  'session.hasTranscriber': () => Promise<boolean>;
  /** Forward an audio blob to the runner's active transcriber.
   *  Audio must be base64-encoded; returns the recognised text. */
  'session.transcribe': (args: {
    audioBase64: string;
    mimeType?: string;
  }) => Promise<string>;
  /** Open a native file picker and return the absolute path the user
   *  chose. Null when cancelled. */
  'session.pickAttachment': () => Promise<string | null>;
  /** Persist a pasted/dropped image blob (the renderer can't write
   *  files) to a temp file the agent can read, and return it as a
   *  {@link PromptAttachment} ready to ship on the next turn. Rejects
   *  if the image exceeds the attachment size cap. */
  'session.saveImageAttachment': (args: {
    /** Base64-encoded image bytes (no `data:` prefix). */
    dataBase64: string;
    /** MIME type from the clipboard blob, e.g. `image/png`. */
    mediaType: string;
    /** Optional source filename; a friendly default is used otherwise. */
    name?: string;
  }) => Promise<PromptAttachment>;

  // ---- Workspace filesystem browsing ------------------------------------
  /** List one directory inside the workspace's cwd. Relative paths
   *  are resolved against the active desk's cwd; absolute paths must
   *  stay below the cwd or the call errors (no traversing out of the
   *  workspace). Returns entries sorted directories-first. */
  'workspace.listDir': (args: {
    workspaceId: string;
    path?: string;
  }) => Promise<{
    readonly cwd: string;
    readonly path: string;
    readonly entries: ReadonlyArray<{
      readonly name: string;
      readonly kind: 'file' | 'dir';
    }>;
  }>;

  // ---- Chat transcript log (main-process append-only NDJSON) ------------
  /** Append committed runner events to the workspace's durable log.
   *  Append-only: never re-serialises old events. */
  'chat.append': (args: {
    workspaceId: string;
    events: ReadonlyArray<MoxxyEvent>;
  }) => Promise<void>;
  /** Load a page of events ending at `before` (a line-index cursor; null
   *  = the tail). Returns the page oldest-first plus `prevCursor` to
   *  request the next-older page (null when the start is reached). */
  'chat.loadSegment': (args: {
    workspaceId: string;
    before: number | null;
    limit: number;
  }) => Promise<{ events: ReadonlyArray<MoxxyEvent>; prevCursor: number | null }>;
  /** Truncate a workspace's log (Clear conversation). */
  'chat.clearLog': (args: { workspaceId: string }) => Promise<void>;
  /** Workspace ids that have a persisted log on disk. */
  'chat.listWorkspaces': () => Promise<ReadonlyArray<string>>;
  /** One-time migration: the renderer hands up the events it parsed from
   *  the legacy localStorage blobs; the main process seeds the NDJSON
   *  logs. Idempotent — skips workspaces whose log already exists. */
  'chat.migrate': (args: {
    workspaces: ReadonlyArray<{ workspaceId: string; events: ReadonlyArray<MoxxyEvent> }>;
  }) => Promise<void>;

  // Workflows
  'workflows.list': () => Promise<ReadonlyArray<WorkflowSummary>>;
  'workflows.setEnabled': (args: { name: string; enabled: boolean }) => Promise<void>;
  'workflows.run': (args: { name: string }) => Promise<WorkflowRun>;

  // Settings
  // Desktop preferences (separate from runner preferences).
  'prefs.read': () => Promise<DesktopPrefs>;
  'prefs.update': (patch: Partial<DesktopPrefs>) => Promise<DesktopPrefs>;

  // Focus-mode window control (from the floating widget back to main).
  'focus.close': () => Promise<void>;
  'focus.restoreMain': () => Promise<void>;
  /** Resize the focus window. Keeps the bottom-right corner pinned
   *  so the dot stays in the corner as the widget expands. */
  'focus.resize': (args: { width: number; height: number }) => Promise<void>;

  /** Provider list for the given workspace (defaults to active). */
  'settings.providers': (args?: { workspaceId?: string }) => Promise<ReadonlyArray<ProviderEntry>>;
  /** Hit the provider's /v1/models endpoint and return the model ids
   *  it advertises. Useful for admin-registered providers whose
   *  providers.json entry didn't enumerate models upfront. */
  'settings.fetchProviderModels': (args: { provider: string }) => Promise<ReadonlyArray<string>>;
  /** Lists every provider name the user could realistically pick from
   *  during onboarding — built-ins (anthropic, openai, openai-codex)
   *  plus anything in ~/.moxxy/providers.json. */
  'settings.providerCatalog': () => Promise<ReadonlyArray<string>>;
  /** Subset of providers that the user added via `provider_add` — the
   *  ones for which live /v1/models fetching is wired. */
  'settings.adminProviders': () => Promise<ReadonlyArray<string>>;
  'settings.mcpServers': (args?: { workspaceId?: string }) => Promise<ReadonlyArray<McpServerEntry>>;
  'settings.mcpToggle': (args: {
    workspaceId?: string;
    name: string;
    enabled: boolean;
  }) => Promise<void>;
  /** Vault entries are global per-user — no workspaceId. */
  'settings.vaultEntries': () => Promise<ReadonlyArray<VaultEntryName>>;
  /** Store (or overwrite) a vault secret. Value is encrypted at rest. */
  'settings.vaultSet': (args: { name: string; value: string }) => Promise<void>;
  /** Delete a vault secret by name. */
  'settings.vaultDelete': (args: { name: string }) => Promise<void>;
  /** Skills under ~/.moxxy/skills are global per-user — no workspaceId. */
  'settings.skills': () => Promise<ReadonlyArray<SkillFile>>;
  'settings.readSkill': (args: { name: string }) => Promise<string>;
  'settings.writeSkill': (args: { name: string; body: string }) => Promise<void>;
  'settings.deleteSkill': (args: { name: string }) => Promise<void>;
}

/** Names of every command, derived. */
export type IpcCommandName = keyof IpcCommands;

// ---------- Shape the preload exposes on `window.moxxy` -------------------

export type SubscribeFn = <K extends keyof IpcEvents>(
  channel: K,
  handler: (payload: IpcEvents[K]) => void,
) => () => void;

export type InvokeFn = <K extends IpcCommandName>(
  command: K,
  ...args: Parameters<IpcCommands[K]>
) => ReturnType<IpcCommands[K]>;

export interface MoxxyApi {
  invoke: InvokeFn;
  subscribe: SubscribeFn;
}
