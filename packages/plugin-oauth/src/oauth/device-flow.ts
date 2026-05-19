import { parseTokenResponse } from './token-exchange.js';
import type { DeviceFlowOptions, TokenSet } from './types.js';

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
 */
export async function runDeviceCodeFlow(opts: DeviceFlowOptions): Promise<TokenSet> {
  const deviceBody = new URLSearchParams();
  deviceBody.set('client_id', opts.clientId);
  deviceBody.set('scope', opts.scopes.join(' '));
  const deviceRes = await fetch(opts.deviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: deviceBody.toString(),
  });
  if (!deviceRes.ok) {
    const text = await deviceRes.text().catch(() => '');
    throw new Error(`device-code request failed (HTTP ${deviceRes.status}): ${text.slice(0, 300)}`);
  }
  const deviceJson = (await deviceRes.json()) as Record<string, unknown>;
  const deviceCode = typeof deviceJson.device_code === 'string' ? deviceJson.device_code : null;
  const userCode = typeof deviceJson.user_code === 'string' ? deviceJson.user_code : null;
  const verificationUri =
    typeof deviceJson.verification_uri === 'string'
      ? deviceJson.verification_uri
      : typeof deviceJson.verification_url === 'string'
        ? deviceJson.verification_url
        : null;
  const verificationUriComplete =
    typeof deviceJson.verification_uri_complete === 'string'
      ? deviceJson.verification_uri_complete
      : undefined;
  const expiresIn = typeof deviceJson.expires_in === 'number' ? deviceJson.expires_in : 600;
  let interval = typeof deviceJson.interval === 'number' ? deviceJson.interval : 5;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(`device-code response missing required fields: ${JSON.stringify(deviceJson).slice(0, 200)}`);
  }

  opts.onPrompt({
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresIn,
    interval,
  });

  const deadline = Date.now() + Math.min((opts.timeoutMs ?? expiresIn * 1000), expiresIn * 1000);

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('OAuth device flow aborted');
    await sleep(interval * 1000, opts.signal);
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
    if (pollRes.ok && typeof pollJson.access_token === 'string') {
      return parseTokenResponse(pollJson);
    }
    const err = typeof pollJson.error === 'string' ? pollJson.error : `HTTP ${pollRes.status}`;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5;
      continue;
    }
    if (err === 'access_denied') throw new Error('OAuth device flow: user denied authorization');
    if (err === 'expired_token') throw new Error('OAuth device flow: device_code expired before approval');
    const desc = typeof pollJson.error_description === 'string' ? pollJson.error_description : '';
    throw new Error(`OAuth device flow failed: ${err}${desc ? ` — ${desc}` : ''}`);
  }
  throw new Error('OAuth device flow timed out waiting for user approval');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
