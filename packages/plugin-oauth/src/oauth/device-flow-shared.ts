import { classifyHttpStatus, MoxxyError } from '@moxxy/sdk';
import { parseTokenResponse } from './token-exchange.js';
import type { PollOutcome } from './poll-until.js';
import type { TokenSet } from './types.js';

/**
 * Parsed RFC 8628 device-authorization response. Times are kept in seconds (as
 * the wire reports them); callers convert to ms where their API needs it.
 */
export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresInSec: number;
  readonly intervalSec: number;
}

/**
 * POST the RFC 8628 device-authorization request and parse the response. The
 * single home for the request + field parsing + error handling shared by the
 * legacy `runDeviceCodeFlow` and the `rfc8628DeviceFlow` adapter.
 */
export async function requestDeviceAuthorization(args: {
  readonly deviceUrl: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}): Promise<DeviceAuthorization> {
  const body = new URLSearchParams();
  body.set('client_id', args.clientId);
  body.set('scope', args.scopes.join(' '));
  const res = await fetch(args.deviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw (
      classifyHttpStatus(res.status, { url: args.deviceUrl, body: text }) ??
      new MoxxyError({
        code: 'AUTH_INVALID',
        message: `device-code request failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
        context: { status: res.status, url: args.deviceUrl },
      })
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const deviceCode = typeof json.device_code === 'string' ? json.device_code : null;
  const userCode = typeof json.user_code === 'string' ? json.user_code : null;
  const verificationUri =
    typeof json.verification_uri === 'string'
      ? json.verification_uri
      : typeof json.verification_url === 'string'
        ? json.verification_url
        : null;
  const verificationUriComplete =
    typeof json.verification_uri_complete === 'string' ? json.verification_uri_complete : undefined;
  const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 600;
  const intervalSec = typeof json.interval === 'number' ? json.interval : 5;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new MoxxyError({
      code: 'PROVIDER_UNKNOWN_RESPONSE',
      message: `device-code response missing required fields: ${JSON.stringify(json).slice(0, 200)}`,
    });
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresInSec,
    intervalSec,
  };
}

/**
 * Classify a device-flow token-poll response per RFC 8628 §3.5: success →
 * `done`; `authorization_pending` → keep waiting; `slow_down` → +5s and wait;
 * `access_denied` / `expired_token` / other → throw a MoxxyError. Shared by both
 * poll loops; each caller builds its own request body (the legacy flow appends
 * client_id/client_secret) and hands the response + parsed JSON here.
 */
export function classifyDeviceTokenResponse(
  res: { readonly ok: boolean; readonly status: number },
  json: Record<string, unknown>,
  state: { intervalMs: number },
): PollOutcome<TokenSet> {
  if (res.ok && typeof json.access_token === 'string') {
    return { done: parseTokenResponse(json) };
  }
  const err = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
  if (err === 'authorization_pending') return { pending: true };
  if (err === 'slow_down') {
    state.intervalMs += 5000;
    return { pending: true };
  }
  if (err === 'access_denied') {
    throw new MoxxyError({
      code: 'OAUTH_FLOW_DENIED',
      message: 'You declined the device authorization.',
      hint: 'Re-run the login command and approve the consent screen on your browser device.',
    });
  }
  if (err === 'expired_token') {
    throw new MoxxyError({
      code: 'OAUTH_FLOW_TIMEOUT',
      message: 'The device code expired before you finished signing in.',
      hint: 'Re-run the login command — a new code will be generated.',
    });
  }
  const desc = typeof json.error_description === 'string' ? json.error_description : '';
  throw new MoxxyError({
    code: 'AUTH_INVALID',
    message: `OAuth device flow failed: ${err}${desc ? ` — ${desc}` : ''}.`,
    context: { provider_error: String(err), ...(desc ? { description: desc } : {}) },
  });
}
