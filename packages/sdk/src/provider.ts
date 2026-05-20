import type { ToolDef } from './tool.js';

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool_result';
  readonly content: ReadonlyArray<ContentBlock>;
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly toolUseId: string; readonly content: string; readonly isError?: boolean }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string }
  | { readonly type: 'audio'; readonly mediaType: string; readonly data: string };

export interface ProviderRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly tools?: ReadonlyArray<ToolDef>;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export type ProviderEvent =
  | { readonly type: 'message_start'; readonly model: string }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_use_delta'; readonly id: string; readonly partialInput: string }
  | { readonly type: 'tool_use_end'; readonly id: string; readonly input: unknown }
  | { readonly type: 'message_end'; readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'; readonly usage?: TokenUsage }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean };

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface ModelDescriptor {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  /**
   * Whether this model accepts `image` ContentBlocks in user messages.
   * Channels gate image attachments on this flag — if a user drops an
   * image while a non-vision model is active, the channel either
   * refuses or warns instead of silently dropping the bytes.
   */
  readonly supportsImages?: boolean;
  /**
   * Whether this model accepts `audio` ContentBlocks in user messages
   * (GPT-4o, Gemini-Live-class models). When false, channels with audio
   * input route through the session's active `Transcriber` and forward
   * the transcript as text instead.
   */
  readonly supportsAudio?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly models: ReadonlyArray<ModelDescriptor>;
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;
  countTokens(req: Pick<ProviderRequest, 'model' | 'messages' | 'system' | 'tools'>): Promise<number>;
}

export type ProviderKeyValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Minimal vault interface exposed to provider auth flows. Implementations
 * (typically `@moxxy/plugin-vault`) supply encrypted storage; the auth
 * descriptor doesn't need anything richer, so we keep the contract small
 * and SDK-Node-free.
 */
export interface ProviderVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, tags?: ReadonlyArray<string>): Promise<void>;
  delete?(key: string): Promise<boolean>;
}

/**
 * Runtime supplied to a provider's OAuth `login(ctx)` callback. The host
 * (e.g. `moxxy init`, `moxxy login <provider>`) constructs this and hands
 * it off; the provider plugin runs the flow end-to-end and persists
 * credentials via `ctx.vault`.
 */
export interface ProviderAuthContext {
  readonly vault: ProviderVault;
  /**
   * True when there is no usable browser or interactive TTY. OAuth flows
   * should fall back to device-code (or equivalent) in this mode rather
   * than spawning a local callback server / opening a browser.
   */
  readonly headless: boolean;
  /**
   * Progress-message sink. The host wires this to its preferred renderer
   * (clack `log.*`, plain stdout, …) so providers don't have to know
   * whether they're running inside a wizard or a one-shot command.
   */
  readonly write: (chunk: string) => void;
}

export interface ProviderOAuthResult {
  /** Human-readable account identifier shown in the success message. */
  readonly accountId?: string | null;
  /** UNIX-ms expiry of the persisted credential; surfaced to users. */
  readonly expiresAt?: number;
}

/**
 * Self-describing auth metadata a provider plugin attaches to its
 * `ProviderDef`. Lets the CLI's setup wizard and `moxxy login` operate
 * generically over any installed provider — no CLI-side branch table.
 *
 * `apiKey`  : the host prompts for a key and calls `validateKey` (if any).
 * `oauth`   : the host hands the provider a `ProviderAuthContext`; the
 *             provider drives the full OAuth dance, including any local
 *             callback server, and persists tokens to `ctx.vault`.
 */
export type ProviderAuthDescriptor =
  | {
      readonly kind: 'apiKey';
      /** Canonical env-var name (e.g. `ANTHROPIC_API_KEY`). Inferred when omitted. */
      readonly envVar?: string;
      /** Short hint shown next to the prompt (e.g. "starts with `sk-ant-`"). */
      readonly hint?: string;
    }
  | {
      readonly kind: 'oauth';
      /** Human-readable name of the upstream service (e.g. "ChatGPT Pro/Plus"). */
      readonly serviceName?: string;
      /**
       * Drive the OAuth flow and persist credentials. Throws on failure /
       * user cancellation; the host typically offers a retry prompt.
       */
      login(ctx: ProviderAuthContext): Promise<ProviderOAuthResult>;
      /**
       * Optional logout — remove persisted credentials from the vault.
       * Returns true if anything was removed, false if there was nothing
       * stored. Used by `moxxy login logout <provider>`.
       */
      logout?(ctx: ProviderAuthContext): Promise<boolean>;
      /**
       * Optional status probe — returns a brief description of the stored
       * credential, or null if none. Used by `moxxy login status`.
       */
      status?(ctx: ProviderAuthContext): Promise<ProviderOAuthStatus | null>;
    };

export interface ProviderOAuthStatus {
  readonly accountId?: string | null;
  readonly expiresAt?: number;
  /** Vault key the credentials are stored under (informational). */
  readonly vaultKey?: string;
}

export interface ProviderDef {
  readonly name: string;
  readonly models: ReadonlyArray<ModelDescriptor>;
  createClient(config: Record<string, unknown>): LLMProvider;
  /**
   * Optional check that the given key is actually accepted by the vendor.
   * Implementations should be cheap (a free metadata call or a 1-token
   * completion). Used by `moxxy init` to verify keys before persisting.
   */
  validateKey?(apiKey: string): Promise<ProviderKeyValidation>;
  /**
   * Optional auth descriptor. When omitted, the host treats the provider
   * as `{ kind: 'apiKey' }` — i.e. prompt for a key, call `validateKey`
   * if defined, store under the canonical vault entry.
   */
  readonly auth?: ProviderAuthDescriptor;
}
