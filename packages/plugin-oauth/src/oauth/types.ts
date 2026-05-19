export interface OAuthFlowOptions {
  /** Provider's authorization endpoint, e.g. https://accounts.google.com/o/oauth2/v2/auth */
  readonly authUrl: string;
  /** Provider's token endpoint, e.g. https://oauth2.googleapis.com/token */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Confidential clients only; loopback flows usually omit. */
  readonly clientSecret?: string;
  readonly scopes: ReadonlyArray<string>;
  /**
   * Loopback redirect port. The redirect URI MUST be registered with
   * the provider exactly (most providers require an exact match) — pick
   * a value and tell the user to register it. Default 8765 to keep the
   * Google Cloud Console setup deterministic across sessions.
   */
  readonly redirectPort?: number;
  /**
   * Loopback redirect path. Default `/callback`. Some providers reject
   * paths other than `/`; tweak per provider. The full registered
   * redirect URI must be `http://localhost:<port><path>` exactly.
   */
  readonly redirectPath?: string;
  /**
   * Provider-specific extra query parameters on the auth URL. Common
   * cases: `access_type=offline` + `prompt=consent` for Google (forces
   * the issuance of a refresh_token); `audience=...` for Auth0.
   */
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  /** How long to wait for the callback before giving up. Default 5min. */
  readonly timeoutMs?: number;
  /**
   * Abort signal — when fired, shuts the local server and rejects the
   * flow. Wire from `ctx.signal` so a turn cancel kills a pending auth.
   */
  readonly signal?: AbortSignal;
  /**
   * When true, do NOT auto-open the browser. The auth URL still
   * gets handed to `onAuthUrl`; the caller is expected to print it
   * for the user to visit on a host where the loopback callback is
   * reachable (same machine, SSH tunnel, port-forward).
   */
  readonly noOpen?: boolean;
  /**
   * Fires with the built auth URL just before the browser-open step.
   * Use to log / display the URL so the user sees it even when
   * auto-open fails or `noOpen` is set.
   */
  readonly onAuthUrl?: (url: string) => void;
}

export interface DeviceFlowOptions {
  /** Provider's device-authorization endpoint (RFC 8628 §3.1). */
  readonly deviceUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scopes: ReadonlyArray<string>;
  /** Hard cap; the device-code's own expires_in usually drives the timer. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Fired ONCE with the user-facing prompt info as soon as the
   * device endpoint returns. Channels should surface this prominently
   * — the whole flow stalls until the user finishes on the URL.
   */
  readonly onPrompt: (info: DevicePrompt) => void;
}

export interface DevicePrompt {
  /** Short code the user types into the verification page. */
  readonly userCode: string;
  /** URL the user opens on any device. */
  readonly verificationUri: string;
  /** Some providers return a URL that already includes the user_code. */
  readonly verificationUriComplete?: string;
  /** Seconds until the device_code expires (from the provider). */
  readonly expiresIn: number;
  /** Poll interval the provider wants us to use, in seconds. */
  readonly interval: number;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms when the access_token expires. */
  readonly expiresAt?: number;
  /** Granted scopes — provider may grant less than requested. */
  readonly scope?: string;
  readonly tokenType: string;
  /** OIDC id_token if the provider returned one (Google does for `openid` scope). */
  readonly idToken?: string;
}
