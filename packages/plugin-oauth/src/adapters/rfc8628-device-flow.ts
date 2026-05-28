/**
 * Standards-compliant device-authorization adapter per RFC 8628.
 *
 * Phases:
 *   1. POST `client_id` + `scope` to `deviceUrl` (form-encoded).
 *   2. Surface `user_code` + `verification_uri` to the user.
 *   3. Poll `tokenUrl` every `interval` with
 *      `grant_type=urn:ietf:params:oauth:grant-type:device_code` + `device_code`.
 *   4. Handle `authorization_pending` / `slow_down` / fatal codes per spec.
 *
 * The device-authorization request + poll-response classification are shared
 * with the legacy `runDeviceCodeFlow` via `oauth/device-flow-shared`.
 */

import {
  classifyDeviceTokenResponse,
  requestDeviceAuthorization,
} from '../oauth/device-flow-shared.js';
import type { TokenSet } from '../oauth/types.js';
import type {
  DeviceFlowAdapter,
  DeviceFlowInit,
  DeviceFlowStartArgs,
} from '../profile.js';
import type { PollOutcome, PollState } from '../oauth/poll-until.js';

export interface Rfc8628AdapterOpts {
  readonly deviceUrl: string;
  readonly tokenUrl: string;
}

interface Rfc8628State {
  readonly deviceCode: string;
}

export function rfc8628DeviceFlow(opts: Rfc8628AdapterOpts): DeviceFlowAdapter {
  return {
    async start(args: DeviceFlowStartArgs): Promise<DeviceFlowInit> {
      const auth = await requestDeviceAuthorization({
        deviceUrl: opts.deviceUrl,
        clientId: args.clientId,
        scopes: args.scopes,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return {
        userCode: auth.userCode,
        verificationUri: auth.verificationUri,
        ...(auth.verificationUriComplete
          ? { verificationUriComplete: auth.verificationUriComplete }
          : {}),
        intervalMs: auth.intervalSec * 1000,
        expiresInMs: auth.expiresInSec * 1000,
        providerData: { deviceCode: auth.deviceCode } satisfies Rfc8628State,
      };
    },

    async poll(init: DeviceFlowInit, state: PollState): Promise<PollOutcome<TokenSet>> {
      const { deviceCode } = init.providerData as Rfc8628State;
      const body = new URLSearchParams();
      body.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
      body.set('device_code', deviceCode);
      const res = await fetch(opts.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return classifyDeviceTokenResponse(res, json, state);
    },
  };
}
