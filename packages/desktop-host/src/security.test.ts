import { describe, it, expect } from 'vitest';
import {
  isSafeProviderName,
  assertSafeProviderName,
  isSafeExternalUrl,
  assertSafeExternalUrl,
  redactSecrets,
} from './security';

describe('provider-name validation', () => {
  it('accepts well-formed slugs', () => {
    for (const ok of ['openai', 'openai-codex', 'anthropic', 'z-ai', 'a', 'a0']) {
      expect(isSafeProviderName(ok)).toBe(true);
    }
  });

  it('rejects flag injection, separators, traversal, and casing', () => {
    for (const bad of [
      '--help',
      '-x',
      'OpenAI',
      'foo bar',
      'foo;rm -rf /',
      '../etc',
      'a/b',
      'a.b',
      'foo\nbar',
      '',
      'x'.repeat(65),
    ]) {
      expect(isSafeProviderName(bad)).toBe(false);
      expect(() => assertSafeProviderName(bad)).toThrow();
    }
  });
});

describe('external-url validation', () => {
  it('allows only http/https', () => {
    expect(isSafeExternalUrl('https://clerk.com')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
  });

  it('rejects RCE-adjacent schemes and garbage', () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'vbscript:msgbox',
      'not a url',
      '',
    ]) {
      expect(isSafeExternalUrl(bad)).toBe(false);
      expect(() => assertSafeExternalUrl(bad)).toThrow();
    }
  });
});

describe('secret redaction', () => {
  it('scrubs api keys, bearer tokens, jwts, and KEY=value', () => {
    expect(redactSecrets('using sk-ABCD1234EFGH5678IJKL')).not.toContain('ABCD1234');
    expect(redactSecrets('Authorization: Bearer abcdef123456ghijkl')).not.toContain('abcdef123456');
    expect(redactSecrets('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaa')).toContain('«redacted»');
    expect(redactSecrets('OPENAI_API_KEY=sk-supersecretvalue')).not.toContain('supersecret');
  });

  it('leaves ordinary log lines intact', () => {
    const line = 'moxxy serve listening on ~/.moxxy/serve.sock';
    expect(redactSecrets(line)).toBe(line);
  });
});
