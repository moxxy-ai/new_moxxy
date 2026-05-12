import type { VaultStore } from '@moxxy/plugin-vault';
import type { CodexTokens } from '@moxxy/plugin-provider-openai-codex';
import { resolveProviderApiKey, type ResolveOptions } from './provider-keys.js';

/**
 * Vault entry name for the ChatGPT OAuth credential bundle. The full
 * JSON-stringified `CodexTokens` record is stored under this key.
 */
export const CODEX_VAULT_KEY = 'OPENAI_CODEX_OAUTH';

/**
 * Provider-aware credential resolution. The existing API-key flow (vault →
 * env → prompt) is unchanged for all providers EXCEPT `openai-codex`, which
 * pulls a JSON OAuth bundle from the vault and exposes both the tokens AND
 * a writeback callback that persists refreshed tokens before the next API
 * call goes out.
 */
export async function resolveProviderCredentials(
  providerName: string,
  vault: VaultStore,
  opts: ResolveOptions = {},
): Promise<Record<string, unknown>> {
  if (providerName === 'openai-codex') return resolveOAuthCodex(vault);
  const { providerConfig } = await resolveProviderApiKey(providerName, vault, opts);
  return providerConfig;
}

async function resolveOAuthCodex(vault: VaultStore): Promise<Record<string, unknown>> {
  let raw: string | null = null;
  try {
    raw = await vault.get(CODEX_VAULT_KEY);
  } catch {
    // Vault couldn't open — treat as "no credentials" and surface the
    // login hint below.
    raw = null;
  }
  if (!raw) {
    throw new Error(
      `No ChatGPT OAuth credentials found in the vault. ` +
        `Run \`moxxy login openai-codex\` to sign in with your ChatGPT Pro/Plus account.`,
    );
  }
  let tokens: CodexTokens;
  try {
    tokens = JSON.parse(raw) as CodexTokens;
  } catch (err) {
    throw new Error(
      `Stored ChatGPT credentials are corrupt — run \`moxxy login openai-codex\` to refresh. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return {
    tokens,
    onTokensRefreshed: async (next: CodexTokens) => {
      await vault.set(CODEX_VAULT_KEY, JSON.stringify(next), ['openai-codex', 'oauth']);
    },
  };
}

export async function readCodexTokens(vault: VaultStore): Promise<CodexTokens | null> {
  let raw: string | null;
  try {
    raw = await vault.get(CODEX_VAULT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CodexTokens;
  } catch {
    return null;
  }
}

export async function deleteCodexTokens(vault: VaultStore): Promise<boolean> {
  try {
    return await vault.delete(CODEX_VAULT_KEY);
  } catch {
    return false;
  }
}

export async function writeCodexTokens(vault: VaultStore, tokens: CodexTokens): Promise<void> {
  await vault.set(CODEX_VAULT_KEY, JSON.stringify(tokens), ['openai-codex', 'oauth']);
}
