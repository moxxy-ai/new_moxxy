import { ORIGINATOR } from '../oauth.js';
import type { CodexTokens } from '../types.js';

export const CODEX_USER_AGENT = `moxxy/0.0.0 (codex)`;

export function buildCodexHeaders(tokens: CodexTokens, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${tokens.access}`,
    originator: ORIGINATOR,
    'User-Agent': CODEX_USER_AGENT,
    session_id: sessionId,
  };
  if (tokens.accountId) headers['ChatGPT-Account-Id'] = tokens.accountId;
  return headers;
}
