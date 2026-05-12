import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  extractAccountId,
  generatePKCE,
  generateState,
  parseJwtClaims,
  refreshTokens,
  SCOPES,
  TOKEN_URL,
} from './oauth.js';

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('generatePKCE', () => {
  it('produces a 64-char verifier and a 43-char SHA-256 base64url challenge', async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });
});

describe('generateState', () => {
  it('returns distinct, url-safe base64 strings', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes all codex-required query params', () => {
    const url = buildAuthorizeUrl('http://localhost:1455/auth/callback', {
      verifier: 'v',
      challenge: 'ch',
    }, 'STATE');
    expect(url.startsWith(`${AUTHORIZE_URL}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(params.get('scope')).toBe(SCOPES);
    expect(params.get('code_challenge')).toBe('ch');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('id_token_add_organizations')).toBe('true');
    expect(params.get('codex_cli_simplified_flow')).toBe('true');
    expect(params.get('state')).toBe('STATE');
    expect(params.get('originator')).toBe('moxxy');
  });
});

describe('parseJwtClaims', () => {
  it('round-trips a manually-encoded JWT', () => {
    const jwt = makeJwt({ sub: 'abc', email: 'me@example.com' });
    expect(parseJwtClaims(jwt)).toEqual({ sub: 'abc', email: 'me@example.com' });
  });

  it('returns undefined for malformed JWTs', () => {
    expect(parseJwtClaims('only.two')).toBeUndefined();
    expect(parseJwtClaims('a.notbase64payload.c')).toBeUndefined();
    expect(parseJwtClaims('')).toBeUndefined();
  });
});

describe('extractAccountId', () => {
  it('prefers the top-level chatgpt_account_id claim', () => {
    const id_token = makeJwt({
      chatgpt_account_id: 'acct_top',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_namespaced' },
      organizations: [{ id: 'org_first' }],
    });
    expect(extractAccountId({ id_token })).toBe('acct_top');
  });

  it('falls back to the namespaced auth-bag claim', () => {
    const id_token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_namespaced' },
      organizations: [{ id: 'org_first' }],
    });
    expect(extractAccountId({ id_token })).toBe('acct_namespaced');
  });

  it('falls back to the first organization id', () => {
    const id_token = makeJwt({ organizations: [{ id: 'org_first' }, { id: 'org_second' }] });
    expect(extractAccountId({ id_token })).toBe('org_first');
  });

  it('returns undefined when no claim matches', () => {
    const id_token = makeJwt({ sub: 'noone' });
    expect(extractAccountId({ id_token })).toBeUndefined();
  });

  it('falls through from id_token to access_token', () => {
    const access_token = makeJwt({ chatgpt_account_id: 'acct_from_access' });
    expect(extractAccountId({ access_token })).toBe('acct_from_access');
  });
});

describe('exchangeCodeForTokens', () => {
  it('posts form-urlencoded body to the token endpoint and normalizes the response', async () => {
    const id_token = makeJwt({ chatgpt_account_id: 'acct_123' });
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('CODE');
      expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('code_verifier')).toBe('VERIFIER');
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          refresh_token: 'RT',
          id_token,
          expires_in: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const before = Date.now();
    const result = await exchangeCodeForTokens(
      'CODE',
      'http://localhost:1455/auth/callback',
      { verifier: 'VERIFIER', challenge: 'CH' },
      fakeFetch as unknown as typeof fetch,
    );
    const after = Date.now();

    expect(result.access).toBe('AT');
    expect(result.refresh).toBe('RT');
    expect(result.accountId).toBe('acct_123');
    expect(result.expires).toBeGreaterThanOrEqual(before + 7200 * 1000);
    expect(result.expires).toBeLessThanOrEqual(after + 7200 * 1000);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(String(fakeFetch.mock.calls[0]![0])).toBe(TOKEN_URL);
  });

  it('throws when the token endpoint returns non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('bad', { status: 400 }));
    await expect(
      exchangeCodeForTokens(
        'CODE',
        'http://localhost:1455/auth/callback',
        { verifier: 'V', challenge: 'C' },
        fakeFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/400/);
  });
});

describe('refreshTokens', () => {
  it('posts refresh_token grant and returns normalized tokens', async () => {
    const fakeFetch = vi.fn(async (_url, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body ?? ''));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('OLD_RT');
      expect(body.get('client_id')).toBe(CLIENT_ID);
      return new Response(
        JSON.stringify({ access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 1800 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const result = await refreshTokens('OLD_RT', fakeFetch as unknown as typeof fetch);
    expect(result.access).toBe('NEW_AT');
    expect(result.refresh).toBe('NEW_RT');
    expect(result.accountId).toBeUndefined();
  });
});
