import { definePlugin, defineTranscriber, type Plugin } from '@moxxy/sdk';
import {
  CodexOAuthTranscriber,
  OPENAI_CODEX_TRANSCRIBER_NAME,
  type CodexOAuthTranscriberOptions,
  type CodexOAuthVault,
} from './transcriber.js';

export {
  CodexOAuthTranscriber,
  DEFAULT_CODEX_TRANSCRIBE_BASE_URL,
  MOXXY_PCM16_24KHZ_MIME,
  OPENAI_CODEX_TRANSCRIBER_NAME,
  buildCodexTranscribeUrl,
  type CodexOAuthTranscriberOptions,
  type CodexOAuthVault,
} from './transcriber.js';
export { pcm16MonoToWav } from './wav.js';

export interface BuildOpenaiCodexSttPluginOptions {
  readonly vault: CodexOAuthVault;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sessionIdProvider?: () => string;
}

export function buildOpenaiCodexSttPlugin(
  opts: BuildOpenaiCodexSttPluginOptions,
): Plugin {
  return definePlugin({
    name: '@moxxy/plugin-stt-openai-codex',
    version: '0.0.0',
    transcribers: [
      defineTranscriber({
        name: OPENAI_CODEX_TRANSCRIBER_NAME,
        displayName: 'OpenAI Codex transcription (OAuth)',
        createClient: (config) => {
          const merged: CodexOAuthTranscriberOptions = {
            vault: opts.vault,
            ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
            ...(opts.sessionIdProvider ? { sessionIdProvider: opts.sessionIdProvider } : {}),
            ...(config as Partial<CodexOAuthTranscriberOptions>),
          };
          return new CodexOAuthTranscriber(merged);
        },
      }),
    ],
  });
}
