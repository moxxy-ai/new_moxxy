import { describe, expect, it } from 'vitest';
import { Session, silentLogger } from '@moxxy/core';
import { definePlugin, defineProvider, defineTranscriber } from '@moxxy/sdk';
import { buildPluginDoctorChecks, buildVoiceDoctorCheck } from './doctor.js';

function makeSession(): Session {
  const session = new Session({ cwd: '/tmp', logger: silentLogger });
  session.pluginHost.registerStatic(
    definePlugin({
      name: '@test/voice-doctor',
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
          name: 'openai-codex-transcribe',
          requirements: [
            { kind: 'provider', name: 'openai-codex', state: 'active' },
            {
              kind: 'runtime',
              name: 'auth:provider:openai-codex',
              state: 'ready',
              hint: 'Run `moxxy login openai-codex`.',
            },
          ],
          createClient: () => ({ name: 'openai-codex-transcribe', transcribe: async () => ({ text: 'ok' }) }),
        }),
      ],
    }),
  );
  return session;
}

describe('buildVoiceDoctorCheck', () => {
  it('reports Codex voice unavailable when openai-codex is not active', () => {
    const session = makeSession();
    session.providers.setActive('anthropic');

    expect(buildVoiceDoctorCheck(session)).toMatchObject({
      id: 'voice',
      status: 'warn',
      message: 'unavailable — openai-codex is not active',
    });
  });

  it('reports Codex voice unavailable when OAuth is not ready', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');

    expect(buildVoiceDoctorCheck(session)).toMatchObject({
      id: 'voice',
      status: 'warn',
      message: 'unavailable — run moxxy login openai-codex',
    });
  });

  it('reports Codex voice ready when provider and OAuth requirements are ready', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');

    expect(buildVoiceDoctorCheck(session)).toMatchObject({
      id: 'voice',
      status: 'ok',
      message: 'ready — provider=openai-codex transcriber=openai-codex-transcribe',
    });
  });

  it('reports Codex voice unavailable when ffmpeg capture is missing', () => {
    const session = makeSession();
    session.providers.setActive('openai-codex');
    session.requirements.setRuntime('auth:provider:openai-codex', 'ready');

    expect(
      buildVoiceDoctorCheck(session, {
        ready: false,
        issues: [
          {
            requirement: { kind: 'runtime', name: 'voice:capture:ffmpeg', state: 'ready' },
            code: 'not_ready',
            message: 'ffmpeg is required for voice input',
            hint: 'Install ffmpeg and ensure it is available on PATH.',
          },
        ],
      }),
    ).toMatchObject({
      id: 'voice',
      status: 'warn',
      message: 'unavailable — ffmpeg is required for voice input',
    });
  });
});

describe('buildPluginDoctorChecks', () => {
  it('reports skipped plugins with hints', () => {
    expect(
      buildPluginDoctorChecks({
        registered: new Set(['base']),
        skipped: [
          {
            pluginName: 'needs-base',
            source: 'static',
            reason: 'unmet_requirements',
            message: 'Required plugin is not registered: base-plugin',
            hints: ['Enable base-plugin.'],
          },
        ],
      }),
    ).toEqual([
      { id: 'plugins', status: 'warn', message: '1 loaded, 1 skipped' },
      {
        id: 'plugin:needs-base',
        status: 'warn',
        message: 'skipped — Required plugin is not registered: base-plugin (Enable base-plugin.)',
      },
    ]);
  });
});
