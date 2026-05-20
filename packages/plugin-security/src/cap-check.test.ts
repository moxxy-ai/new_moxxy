import { describe, expect, it } from 'vitest';
import { checkFsCap, checkNetCap, checkAllCaps, maskEnv } from './cap-check.js';

describe('checkFsCap', () => {
  it('passes when no path-like input is present', () => {
    const r = checkFsCap({ count: 3, name: 'foo' }, undefined, '/work');
    expect(r.ok).toBe(true);
  });

  it('denies path inputs when no fs cap is declared', () => {
    const r = checkFsCap({ file: '/etc/passwd' }, undefined, '/work');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no fs capability/);
  });

  it('accepts paths inside $cwd glob', () => {
    const r = checkFsCap(
      { file: '/work/src/main.ts' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects paths outside $cwd', () => {
    const r = checkFsCap(
      { file: '/etc/passwd' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/outside/);
  });

  it('accepts file:// URLs that map under the glob', () => {
    const r = checkFsCap(
      { src: 'file:///work/src/x.ts' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(true);
  });

  it('detects file_path (snake_case) as a path field', () => {
    const r = checkFsCap(
      { file_path: '/etc/passwd' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(false);
  });

  it('detects filePath (camelCase) as a path field', () => {
    const r = checkFsCap(
      { filePath: '/etc/passwd' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(false);
  });

  it('detects outputDir as a path field', () => {
    const r = checkFsCap(
      { outputDir: '/etc' },
      { write: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(false);
  });

  it('does NOT scan command strings or generic value fields', () => {
    // Bash-shaped input: `command` is an opaque string. The inproc
    // isolator can't enforce on shell commands; that's by design.
    const r = checkFsCap(
      { command: 'cat /etc/passwd', cwd: '/work' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(true);
  });

  it('does NOT flag absolute paths embedded in prose', () => {
    const r = checkFsCap(
      { description: 'see /usr/bin/foo for details' },
      { read: ['$cwd/**'] },
      '/work',
    );
    expect(r.ok).toBe(true);
  });
});

describe('checkNetCap', () => {
  it('passes when no URL is present', () => {
    const r = checkNetCap({ x: 1 }, undefined);
    expect(r.ok).toBe(true);
  });

  it('denies URL inputs when net mode is none', () => {
    const r = checkNetCap({ url: 'https://example.com/' }, { mode: 'none' });
    expect(r.ok).toBe(false);
  });

  it('accepts URLs when net mode is any', () => {
    const r = checkNetCap({ url: 'https://example.com/' }, { mode: 'any' });
    expect(r.ok).toBe(true);
  });

  it('enforces host allowlist exactly', () => {
    const cap = { mode: 'allowlist' as const, hosts: ['api.example.com'] };
    expect(checkNetCap({ url: 'https://api.example.com/x' }, cap).ok).toBe(true);
    expect(checkNetCap({ url: 'https://evil.com/x' }, cap).ok).toBe(false);
  });

  it('allows subdomains via wildcard hosts', () => {
    const cap = { mode: 'allowlist' as const, hosts: ['*.example.com'] };
    expect(checkNetCap({ url: 'https://api.example.com/' }, cap).ok).toBe(true);
    expect(checkNetCap({ url: 'https://example.com/' }, cap).ok).toBe(false);
  });
});

describe('checkAllCaps', () => {
  it('returns the first failing cap', () => {
    const r = checkAllCaps(
      { url: 'https://evil.com', file: '/work/x' },
      { net: { mode: 'none' }, fs: { read: ['$cwd/**'] } },
      '/work',
    );
    expect(r.ok).toBe(false);
  });
});

describe('maskEnv', () => {
  it('returns only the allowlisted env keys', () => {
    const env = { HOME: '/home/x', SECRET: 'shh', PATH: '/usr/bin' };
    expect(maskEnv(env, ['HOME', 'PATH'])).toEqual({ HOME: '/home/x', PATH: '/usr/bin' });
  });

  it('returns empty when no allowlist is provided', () => {
    expect(maskEnv({ HOME: '/x' }, undefined)).toEqual({});
  });
});
