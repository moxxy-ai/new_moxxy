/**
 * Provider-framework types. A new OAuth provider plugs in by exporting an
 * `OAuthProviderProfile` and (if it supports device-flow) one of the bundled
 * adapters — or a custom adapter for a non-standard dialect.
 *
 * The host then calls `runOauthLogin(profile, ctx)` to drive the full dance
 * and `ensureFreshTokens(profile, vault)` before each upstream request to
 * keep the access token fresh.
 */

import type { PollOutcome, PollState } from './oauth/poll-until.js';
import type { TokenSet } from './oauth/types.js';

/**
 * Single source of truth for everything OAuth-related about a provider.
 * Constants + extraction logic live here; the framework handles the
 * actual HTTP / vault / refresh plumbing.
 */
export interface OAuthProviderProfile {
  /**
   * Stable namespace under `oauth/<id>/*` in the vault. Lowercase,
   * digits, dot/dash/underscore only — same rules as `validateProvider`.
   * Example: `'openai-codex'`, `'google'`, `'github'`.
   */
  readonly id: string;
  /** Authorization endpoint, e.g. https://accounts.google.com/o/oauth2/v2/auth */
  readonly authUrl: string;
  /** Token endpoint, e.g. https://oauth2.googleapis.com/token */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Confidential clients only — loopback flows usually omit. */
  readonly clientSecret?: string;
  readonly scopes: ReadonlyArray<string>;
  /**
   * Provider-specific auth-URL params. Google wants
   * `access_type=offline` + `prompt=consent` for a refresh_token; Codex
   * wants `id_token_add_organizations=true` etc.
   */
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  /**
   * Loopback callback config. Provider's registered redirect URI must
   * match `http://localhost:<port><path>` EXACTLY.
   */
  readonly redirect?: {
    readonly port?: number;
    readonly path?: string;
  };
  /**
   * Device-flow adapter. Omit when the provider doesn't support a
   * headless flow — `runOauthLogin` will reject `headless=true` with a
   * helpful message.
   */
  readonly deviceFlow?: DeviceFlowAdapter;
  /**
   * Pull a stable per-account identifier out of the token set. Codex
   * extracts `chatgpt_account_id` from the id_token; Google could
   * extract `email`. Returned value is shown to the user post-login and
   * persisted under `extras.account_id`. Optional — providers that
   * don't expose a useful identifier skip it.
   */
  readonly extractAccountId?: (tokens: TokenSet) => string | undefined;
  /**
   * Extract extra provider-specific fields to persist alongside the
   * token set (e.g. `team_slug`, `org_id`). Merged with the account_id
   * (if any) into the `extras` map under `oauth/<id>/extras`.
   */
  readonly extractExtras?: (tokens: TokenSet) => Readonly<Record<string, string>>;
  /**
   * Human-readable name used in prompts and success messages, e.g.
   * "ChatGPT Pro/Plus", "Google Workspace". Falls back to `id` when omitted.
   */
  readonly displayName?: string;
}

/**
 * Pluggable device-flow contract. Implementations encode a single dialect
 * (RFC 8628, OpenAI's flavor, ...). The framework calls `start()` once,
 * surfaces the returned prompt to the user, then modes on `poll()` via
 * the shared `pollUntil` primitive.
 */
export interface DeviceFlowAdapter {
  start(args: DeviceFlowStartArgs): Promise<DeviceFlowInit>;
  /**
   * Single poll attempt against the provider's poll endpoint. May
   * mutate `state.intervalMs` to honour a `slow_down` from the server.
   * Resolves to `{done}` with the issued TokenSet, or `{pending: true}`
   * to keep polling. Throws on fatal errors (denied / expired).
   */
  poll(init: DeviceFlowInit, state: PollState): Promise<PollOutcome<TokenSet>>;
}

export interface DeviceFlowStartArgs {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export interface DeviceFlowInit {
  /** Short code the user enters at `verificationUri`. */
  readonly userCode: string;
  readonly verificationUri: string;
  /** Some providers return a URL that already embeds the user_code. */
  readonly verificationUriComplete?: string;
  /** Initial poll interval. The framework honours `slow_down` bumps. */
  readonly intervalMs: number;
  /** Hard deadline (ms from now) before the device_code dies. */
  readonly expiresInMs: number;
  /**
   * Opaque data the adapter threads from `start()` to `poll()` —
   * device_code, server-assigned ids, code_verifier, etc. The framework
   * never inspects this.
   */
  readonly providerData: unknown;
}

export interface RunOauthLoginCtx {
  readonly vault: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, tags?: ReadonlyArray<string>): Promise<void>;
    delete?(key: string): Promise<boolean>;
  };
  /** True ⇒ choose the device flow. False ⇒ open a browser. */
  readonly headless: boolean;
  /** Progress-message sink. The host wires this to its preferred renderer. */
  readonly write: (chunk: string) => void;
  readonly signal?: AbortSignal;
}

export interface RunOauthLoginResult {
  readonly tokens: TokenSet;
  /** Convenience surface for `ProviderOAuthResult.accountId`. */
  readonly accountId?: string;
  readonly extras: Readonly<Record<string, string>>;
}
