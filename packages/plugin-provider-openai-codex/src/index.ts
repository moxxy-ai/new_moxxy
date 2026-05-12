import { defineProvider, definePlugin } from '@moxxy/sdk';
import { CodexProvider, type CodexProviderConfig } from './provider.js';
import { codexModels } from './models.js';

export const openaiCodexProviderDef = defineProvider({
  name: 'openai-codex',
  models: [...codexModels],
  createClient: (config) => new CodexProvider(config as CodexProviderConfig),
  // No validateKey: OAuth credentials are validated by the OAuth token
  // exchange itself, not by a synchronous key check.
});

export const openaiCodexPlugin = definePlugin({
  name: '@moxxy/plugin-provider-openai-codex',
  version: '0.0.0',
  providers: [openaiCodexProviderDef],
});

export default openaiCodexPlugin;

export { CodexProvider } from './provider.js';
export { codexModels, DEFAULT_CODEX_MODEL } from './models.js';
export {
  CLIENT_ID,
  ISSUER,
  AUTHORIZE_URL,
  TOKEN_URL,
  CODEX_RESPONSES_URL,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_REDIRECT_PATH,
  DEFAULT_REDIRECT_URI,
  SCOPES,
  ORIGINATOR,
  generatePKCE,
  generateState,
  buildAuthorizeUrl,
  parseJwtClaims,
  extractAccountId,
  exchangeCodeForTokens,
  refreshTokens,
} from './oauth.js';
export { toResponsesBody, toResponsesInput, toResponsesTools } from './translate.js';
export type { CodexProviderConfig } from './provider.js';
export type { CodexTokens, PkceCodes, OAuthTokenResponse } from './types.js';
