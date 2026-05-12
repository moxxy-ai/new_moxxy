/**
 * OAuth credentials for the OpenAI Codex (ChatGPT Pro/Plus) provider.
 * `expires` is an absolute epoch-millis timestamp so a paused process resumes
 * with a correct refresh decision regardless of clock drift across runs.
 */
export interface CodexTokens {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
}

export interface PkceCodes {
  readonly verifier: string;
  readonly challenge: string;
}

/**
 * Raw shape returned by https://auth.openai.com/oauth/token. Used internally
 * by `exchangeCodeForTokens` / `refreshTokens` before normalization.
 */
export interface OAuthTokenResponse {
  readonly id_token?: string;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in?: number;
  readonly token_type?: string;
}
