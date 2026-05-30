import { describe, it, expect } from 'vitest';
import { validateIpcInput } from './validation.js';

describe('IPC payload validation', () => {
  it('rejects non-http(s) openExternal URLs', () => {
    expect(() => validateIpcInput('onboarding.openExternal', { url: 'https://ok.com' })).not.toThrow();
    expect(() => validateIpcInput('onboarding.openExternal', { url: 'file:///etc/passwd' })).toThrow();
    expect(() => validateIpcInput('onboarding.openExternal', { url: 'javascript:alert(1)' })).toThrow();
  });

  it('confines provider names to a slug', () => {
    expect(() => validateIpcInput('onboarding.runProviderLogin', { provider: 'openai-codex' })).not.toThrow();
    expect(() => validateIpcInput('onboarding.runProviderLogin', { provider: '--flag' })).toThrow();
    expect(() => validateIpcInput('onboarding.saveProviderKey', { provider: '../x', secret: 'k' })).toThrow();
  });

  it('blocks skill-name path traversal', () => {
    expect(() => validateIpcInput('settings.writeSkill', { name: 'my-skill', body: 'x' })).not.toThrow();
    expect(() => validateIpcInput('settings.deleteSkill', { name: '../../etc/passwd' })).toThrow();
    expect(() => validateIpcInput('settings.readSkill', { name: '/abs/path' })).toThrow();
  });

  it('rejects oversize transcribe payloads', () => {
    expect(() => validateIpcInput('session.transcribe', { audioBase64: 'AAAA' })).not.toThrow();
    expect(() =>
      validateIpcInput('session.transcribe', { audioBase64: 'A'.repeat(40_000_001) }),
    ).toThrow();
  });

  it('whitelists prefs.update fields (rejects unknown keys)', () => {
    expect(() => validateIpcInput('prefs.update', { onboardingComplete: true })).not.toThrow();
    expect(() => validateIpcInput('prefs.update', { version: 99 })).toThrow();
    expect(() => validateIpcInput('prefs.update', { evil: 'x' })).toThrow();
  });

  it('is a no-op for commands without a schema', () => {
    expect(() => validateIpcInput('desks.list', undefined)).not.toThrow();
    expect(() => validateIpcInput('connection.snapshotAll', undefined)).not.toThrow();
  });
});
