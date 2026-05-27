import { describe, expect, it } from 'vitest';
import { definePlugin, defineProvider, defineTranscriber } from '@moxxy/sdk';
import { Session } from './session.js';
import { silentLogger } from './logger.js';
import { checkCodexTranscriptionReady, resolveCodexTranscriber } from './codex-voice.js';

function makeSession(): Session {
  const session = new Session({ cwd: '/tmp', logger: silentLogger });
  session.pluginHost.registerStatic(
    definePlugin({
      name: '@test/codex-voice',
      providers: [
        defineProvider({
          name: 'openai-codex',
          models: [{ id: 'gpt-5.5', contextWindow: 300_000, supportsTools: true, supportsStreaming: true }],
          createClient: () => ({ name: 'openai-codex', models: [], stream: async function* () {}, countTokens: async () => 0 }),
        }),
      ],
      transcribers: [
        defineTranscriber({
          name: 'openai-codex-transcribe',
          createClient: () => ({ name: 'openai-codex-transcribe', transcribe: async () => ({ text: 'hello' }) }),
        }),
        defineTranscriber({
          name: 'other-transcriber',
          createClient: () => ({ name: 'other-transcriber', transcribe: async () => ({ text: 'other' }) }),
        }),
      ],
    }),
  );
  return session;
}

describe('Codex transcription readiness', () => {
  it('is ready only when Codex provider, OAuth runtime and Codex transcriber are available', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');

    expect(checkCodexTranscriptionReady(session)).toEqual({ ready: true, issues: [] });
    expect(resolveCodexTranscriber(session).name).toBe('openai-codex-transcribe');
  });

  it('reports a conflict instead of overwriting another active transcriber', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');
    session.transcribers.setActive('other-transcriber');

    const check = checkCodexTranscriptionReady(session);

    expect(check.ready).toBe(false);
    expect(check.issues[0]?.message).toContain('active is other-transcriber');
    expect(() => resolveCodexTranscriber(session)).toThrow(/openai-codex-transcribe/);
    expect(session.transcribers.getActiveName()).toBe('other-transcriber');
  });
});
