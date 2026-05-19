import { computeCodeChallenge, generateCodeVerifier, generateState } from '../pkce.js';
import { openInBrowser } from '../open-browser.js';
import { waitForCallback } from './callback-server.js';
import { exchangeCodeForToken } from './token-exchange.js';
import type { OAuthFlowOptions, TokenSet } from './types.js';

export interface BuildAuthUrlInput {
  readonly authUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly codeChallenge: string;
  readonly state: string;
  readonly extraAuthParams?: Readonly<Record<string, string>>;
}

/** Pure URL builder, exported separately so tests can assert on it. */
export function buildAuthUrl(input: BuildAuthUrlInput): string {
  const url = new URL(input.authUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(input.extraAuthParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Run the full authorization-code-with-PKCE dance:
 *   1. Bind a loopback HTTP server on `redirectPort`.
 *   2. Build the auth URL (PKCE challenge, CSRF state, scopes, etc.).
 *   3. Open the URL in the user's default browser.
 *   4. Wait for the provider to redirect back with `code` + `state`.
 *   5. Verify state, POST the code to the token endpoint with the
 *      verifier, return the parsed token set.
 */
export async function runAuthorizationCodeFlow(opts: OAuthFlowOptions): Promise<TokenSet> {
  const port = opts.redirectPort ?? 8765;
  const path = opts.redirectPath ?? '/callback';
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = generateState();
  const redirectUri = `http://localhost:${port}${path}`;

  const authUrl = buildAuthUrl({
    authUrl: opts.authUrl,
    clientId: opts.clientId,
    redirectUri,
    scopes: opts.scopes,
    codeChallenge,
    state,
    ...(opts.extraAuthParams ? { extraAuthParams: opts.extraAuthParams } : {}),
  });

  // Start the server BEFORE opening the browser — otherwise the user
  // could complete the consent screen before we're listening and the
  // redirect would 404.
  const codePromise = waitForCallback({
    port,
    path,
    expectedState: state,
    timeoutMs: opts.timeoutMs ?? 300_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (opts.onAuthUrl) opts.onAuthUrl(authUrl);
  if (!opts.noOpen) {
    try {
      await openInBrowser(authUrl);
    } catch {
      // Failed to open the browser — not fatal; the user can visit
      // the URL surfaced via onAuthUrl. The loopback server is still
      // listening.
    }
  }

  const code = await codePromise;
  return exchangeCodeForToken({
    tokenUrl: opts.tokenUrl,
    code,
    redirectUri,
    clientId: opts.clientId,
    ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
    codeVerifier,
  });
}
