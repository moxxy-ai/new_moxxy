import { pollUntil, type PollOutcome } from './poll-until.js';
import { classifyDeviceTokenResponse, requestDeviceAuthorization } from './device-flow-shared.js';
import type { DeviceFlowOptions, TokenSet } from './types.js';

const DEVICE_POLL_SAFETY_MARGIN_MS = 0;

/**
 * Run the RFC 8628 device-authorization flow. Suitable for headless
 * environments (SSH session, CI, kiosk, no display): the user opens
 * the verification URL on any device, types the short user_code,
 * approves the scopes, and the local process discovers the grant by
 * polling the token endpoint.
 *
 * Phases:
 *   1. POST `client_id` + `scope` to deviceUrl → returns user_code,
 *      verification_uri, device_code, expires_in, interval.
 *   2. `onPrompt` fires once with the user-facing pieces — the caller
 *      surfaces them in whatever UI it has.
 *   3. Poll tokenUrl every `interval` seconds with
 *      grant_type=urn:ietf:params:oauth:grant-type:device_code +
 *      device_code. The provider replies:
 *        - authorization_pending → keep polling.
 *        - slow_down            → bump interval by 5s and keep polling.
 *        - access_denied        → user clicked deny; throw.
 *        - expired_token        → device_code expired; throw.
 *        - access_token, ...    → success; return TokenSet.
 *
 * The device-authorization request + the poll-response classification are
 * shared with the {@link rfc8628DeviceFlow} adapter via `device-flow-shared`.
 * This flow additionally sends `client_id` (+ optional `client_secret`) on the
 * poll, which is why it builds its own poll body.
 */
export async function runDeviceCodeFlow(opts: DeviceFlowOptions): Promise<TokenSet> {
  const auth = await requestDeviceAuthorization({
    deviceUrl: opts.deviceUrl,
    clientId: opts.clientId,
    scopes: opts.scopes,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  opts.onPrompt({
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    ...(auth.verificationUriComplete ? { verificationUriComplete: auth.verificationUriComplete } : {}),
    expiresIn: auth.expiresInSec,
    interval: auth.intervalSec,
  });

  return pollUntil((state) => pollOnce(opts, auth.deviceCode, state), {
    intervalMs: auth.intervalSec * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS,
    timeoutMs: Math.min(opts.timeoutMs ?? auth.expiresInSec * 1000, auth.expiresInSec * 1000),
    label: 'OAuth device flow',
    leadingWait: true,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

async function pollOnce(
  opts: DeviceFlowOptions,
  deviceCode: string,
  state: { intervalMs: number },
): Promise<PollOutcome<TokenSet>> {
  const body = new URLSearchParams();
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
  body.set('device_code', deviceCode);
  body.set('client_id', opts.clientId);
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  const pollRes = await fetch(opts.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const pollJson = (await pollRes.json().catch(() => ({}))) as Record<string, unknown>;
  return classifyDeviceTokenResponse(pollRes, pollJson, state);
}
