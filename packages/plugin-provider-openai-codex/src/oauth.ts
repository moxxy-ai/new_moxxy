import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import type { CodexTokens, OAuthTokenResponse, PkceCodes } from './types.js';

/**
 * Public OAuth client id baked into the first-party Codex / OpenCode clients.
 * Same value used by codex-rs (`codex-rs/login/src/auth/manager.rs`) and
 * opencode (`packages/opencode/src/plugin/codex.ts`) — using it lets a moxxy
 * login interoperate with credentials produced by either tool.
 */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ISSUER = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
export const TOKEN_URL = `${ISSUER}/oauth/token`;
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const DEFAULT_CALLBACK_PORT = 1455;
export const DEFAULT_REDIRECT_PATH = '/auth/callback';
export const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_CALLBACK_PORT}${DEFAULT_REDIRECT_PATH}`;
export const SCOPES = 'openid profile email offline_access';
export const ORIGINATOR = 'moxxy';

const PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const PKCE_VERIFIER_LEN = 64;

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(view).toString('base64url');
}

function randomString(length: number, charset: string): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i]! % charset.length];
  return out;
}

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = randomString(PKCE_VERIFIER_LEN, PKCE_CHARSET);
  const hash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(hash) };
}

export function generateState(): string {
  return base64UrlEncode(webcrypto.getRandomValues(new Uint8Array(32)));
}

export function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    // These two flags are what codex-rs / opencode pass; without them the
    // returned id_token won't carry the chatgpt_account_id / organizations
    // claims we need to populate the ChatGPT-Account-Id header.
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * JWT-claim extraction — header.payload.signature with base64url-encoded
 * segments. We never verify the signature: the access_token is only ever
 * sent back to the issuer (or its API gateway), so trust is rooted in the
 * fact that we received the token over TLS from the token endpoint. The
 * only thing we use these claims for is plucking the chatgpt_account_id
 * for the per-request header.
 */
export function parseJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

interface AccountIdSource {
  readonly access_token?: string;
  readonly id_token?: string;
}

/**
 * Account-id priority order matches opencode's `extractAccountIdFromClaims`:
 * the explicit top-level claim → the namespaced auth-bag claim → first
 * organization id. Returning undefined is fine — the API just won't
 * receive the optional ChatGPT-Account-Id header.
 */
export function extractAccountId(tokens: AccountIdSource): string | undefined {
  for (const candidate of [tokens.id_token, tokens.access_token]) {
    if (!candidate) continue;
    const claims = parseJwtClaims(candidate);
    if (!claims) continue;
    const direct = claims['chatgpt_account_id'];
    if (typeof direct === 'string' && direct) return direct;
    const authBag = claims['https://api.openai.com/auth'];
    if (authBag && typeof authBag === 'object') {
      const fromBag = (authBag as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof fromBag === 'string' && fromBag) return fromBag;
    }
    const orgs = claims['organizations'];
    if (Array.isArray(orgs) && orgs.length > 0) {
      const first = orgs[0] as { id?: unknown };
      if (first && typeof first.id === 'string' && first.id) return first.id;
    }
  }
  return undefined;
}

async function postToken(body: URLSearchParams, fetchImpl: typeof fetch): Promise<OAuthTokenResponse> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token endpoint returned ${response.status}: ${text || response.statusText}`);
  }
  return (await response.json()) as OAuthTokenResponse;
}

function normalizeTokens(raw: OAuthTokenResponse, now: number = Date.now()): CodexTokens {
  const expires = now + (raw.expires_in ?? 3600) * 1000;
  const accountId = extractAccountId({ id_token: raw.id_token, access_token: raw.access_token });
  return accountId
    ? { access: raw.access_token, refresh: raw.refresh_token, expires, accountId }
    : { access: raw.access_token, refresh: raw.refresh_token, expires };
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
  });
  return normalizeTokens(await postToken(body, fetchImpl));
}

/**
 * Device-authorization start: returns a short user code the user enters at
 * https://auth.openai.com/codex/device on any browser-capable device.
 * Used by the headless login path (no-TTY or `--no-browser`) so SSH
 * sessions / CI / docker containers can sign in without a local browser.
 *
 * Mirrors opencode's "ChatGPT Pro/Plus (headless)" auth method.
 */
export interface DeviceAuthInit {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalMs: number;
}

export async function startDeviceAuth(fetchImpl: typeof fetch = fetch): Promise<DeviceAuthInit> {
  const response = await fetchImpl(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Device auth init failed: ${response.status} ${text || response.statusText}`);
  }
  const data = (await response.json()) as {
    device_auth_id: string;
    user_code: string;
    interval?: string | number;
  };
  const intervalSec = Math.max(typeof data.interval === 'string' ? parseInt(data.interval, 10) : data.interval ?? 5, 1);
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUri: `${ISSUER}/codex/device`,
    intervalMs: intervalSec * 1000,
  };
}

/**
 * Polls the device-auth token endpoint until the user finishes the browser
 * step. 403/404 → "still waiting, try again after `interval`". Any other
 * non-2xx → fatal. On success, exchanges the returned authorization_code
 * for real tokens via the standard /oauth/token endpoint.
 *
 * Polls are throttled by `intervalMs + safetyMarginMs` to stay clear of
 * the server's rate limit. Times out after `timeoutMs`.
 */
export async function pollDeviceAuth(
  init: DeviceAuthInit,
  opts: { timeoutMs: number; safetyMarginMs?: number; signal?: AbortSignal } = { timeoutMs: 10 * 60 * 1000 },
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokens> {
  const safety = opts.safetyMarginMs ?? 3000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Device auth polling aborted');
    const response = await fetchImpl(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: init.deviceAuthId, user_code: init.userCode }),
    });
    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };
      // Exchange the server-side authorization_code + verifier for the
      // real OAuth bundle. The redirect_uri here is the device-auth
      // callback the issuer expects — it's not actually a redirect target
      // we listen on, just a value that must match what the server bound.
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: data.authorization_code,
        redirect_uri: `${ISSUER}/deviceauth/callback`,
        client_id: CLIENT_ID,
        code_verifier: data.code_verifier,
      });
      return normalizeTokens(await postToken(tokenBody, fetchImpl));
    }
    if (response.status !== 403 && response.status !== 404) {
      const text = await response.text().catch(() => '');
      throw new Error(`Device auth poll failed: ${response.status} ${text || response.statusText}`);
    }
    await new Promise((r) => setTimeout(r, init.intervalMs + safety));
  }
  throw new Error('Device auth timed out — re-run `moxxy login openai-codex`');
}

/**
 * Refresh both the access AND refresh tokens. The OAuth server issues a
 * fresh refresh_token on every refresh and INVALIDATES the previous one —
 * callers must persist the returned tokens BEFORE issuing any API call
 * that might fail mid-flight, otherwise a crash will lock the user out.
 */
export async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  return normalizeTokens(await postToken(body, fetchImpl));
}
