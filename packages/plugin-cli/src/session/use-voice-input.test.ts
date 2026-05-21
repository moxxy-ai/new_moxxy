import { describe, expect, it } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin, defineProvider, defineTranscriber } from '@moxxy/sdk';
import {
  checkCodexVoiceInputReady,
  combineVoiceInputReadiness,
  formatVoiceReadinessNotice,
  resolveCodexTranscriber,
} from './use-voice-input.js';

function makeSession(): Session {
  const session = new Session({ cwd: '/tmp', logger: silentLogger });
  session.pluginHost.registerStatic(
    definePlugin({
      name: '@test/voice',
      providers: [
        defineProvider({
          name: 'anthropic',
          models: [],
          createClient: () => ({ name: 'anthropic', models: [], stream: async function* () {}, countTokens: async () => 0 }),
        }),
        defineProvider({
          name: 'openai-codex',
          models: [],
          createClient: () => ({ name: 'openai-codex', models: [], stream: async function* () {}, countTokens: async () => 0 }),
        }),
      ],
      transcribers: [
        defineTranscriber({
          name: 'other-transcriber',
          createClient: () => ({ name: 'other-transcriber', transcribe: async () => ({ text: 'other' }) }),
        }),
        defineTranscriber({
          name: 'openai-codex-transcribe',
          requirements: [
            { kind: 'provider', name: 'openai-codex', state: 'active' },
            { kind: 'runtime', name: 'auth:provider:openai-codex', state: 'ready' },
          ],
          createClient: () => ({ name: 'openai-codex-transcribe', transcribe: async () => ({ text: 'codex' }) }),
        }),
      ],
    }),
  );
  return session;
}

describe('Codex voice input readiness', () => {
  it('is unavailable on non-Codex providers', () => {
    const session = makeSession();
    session.providers.setActive('anthropic');

    const check = checkCodexVoiceInputReady(session);

    expect(check.ready).toBe(false);
    expect(formatVoiceReadinessNotice(check)).toBe(
      'voice: Codex voice requires active provider openai-codex',
    );
  });

  it('is unavailable on Codex provider until OAuth is ready', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');

    const check = checkCodexVoiceInputReady(session);

    expect(check.ready).toBe(false);
    expect(formatVoiceReadinessNotice(check)).toBe(
      'voice: run moxxy login openai-codex to enable Codex voice',
    );
  });

  it('is ready with active Codex provider and ready OAuth runtime fact', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');

    expect(checkCodexVoiceInputReady(session)).toEqual({ ready: true, issues: [] });
    expect(resolveCodexTranscriber(session).name).toBe('openai-codex-transcribe');
  });

  it('is unavailable when local ffmpeg capture is not ready', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');

    const check = combineVoiceInputReadiness(checkCodexVoiceInputReady(session), {
      ready: false,
      issues: [
        {
          requirement: { kind: 'runtime', name: 'voice:capture:ffmpeg', state: 'ready' },
          code: 'not_ready',
          message: 'ffmpeg is required for voice input',
          hint: 'Install ffmpeg and ensure it is available on PATH.',
        },
      ],
    });

    expect(check.ready).toBe(false);
    expect(formatVoiceReadinessNotice(check)).toBe('voice: ffmpeg is required for voice input');
  });

  it('does not overwrite another active transcriber', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');
    session.transcribers.setActive('other-transcriber');

    const check = checkCodexVoiceInputReady(session);

    expect(check.ready).toBe(false);
    expect(() => resolveCodexTranscriber(session)).toThrow(/active transcriber openai-codex-transcribe/);
    expect(session.transcribers.getActiveName()).toBe('other-transcriber');
  });
});
