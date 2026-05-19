import type { TokenSet } from './types.js';

interface ExchangeCodeInput {
  readonly tokenUrl: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly codeVerifier: string;
}

export async function exchangeCodeForToken(input: ExchangeCodeInput): Promise<TokenSet> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);
  body.set('client_id', input.clientId);
  body.set('code_verifier', input.codeVerifier);
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const res = await fetch(input.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  return parseTokenResponse(json);
}

/**
 * Refresh an access token using a stored refresh_token. Same token
 * endpoint, different grant_type. Returns a new TokenSet — note that
 * providers MAY or MAY NOT rotate the refresh_token (Google does
 * not; Auth0 with rotation does). Caller should preserve the prior
 * refresh_token if the response omits one.
 */
export async function refreshAccessToken(input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
}): Promise<TokenSet> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);
  body.set('client_id', input.clientId);
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const res = await fetch(input.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  return parseTokenResponse(json);
}

export function parseTokenResponse(json: Record<string, unknown>): TokenSet {
  const access = typeof json.access_token === 'string' ? json.access_token : null;
  if (!access) throw new Error(`token response missing access_token: ${JSON.stringify(json).slice(0, 200)}`);
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : undefined;
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
  const scope = typeof json.scope === 'string' ? json.scope : undefined;
  const tokenType = typeof json.token_type === 'string' ? json.token_type : 'Bearer';
  const idToken = typeof json.id_token === 'string' ? json.id_token : undefined;
  return {
    accessToken: access,
    ...(refresh !== undefined ? { refreshToken: refresh } : {}),
    ...(expiresIn != null ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(scope !== undefined ? { scope } : {}),
    tokenType,
    ...(idToken !== undefined ? { idToken } : {}),
  };
}
