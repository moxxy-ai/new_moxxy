import type { ParsedArgv } from '../argv.js';
import { bootSessionWithConfig, hasBoolFlag } from '../argv-helpers.js';
import { colors } from '../colors.js';
import { startCallbackServer } from '../oauth-server.js';
import {
  CODEX_VAULT_KEY,
  deleteCodexTokens,
  readCodexTokens,
  writeCodexTokens,
} from '../provider-credentials.js';

const HELP = `moxxy login — OAuth sign-in for providers that don't use API keys

  moxxy login openai-codex          Sign in with ChatGPT Pro/Plus (Codex backend)
                                    Flags:
                                      --no-browser   force the headless device-code flow
                                                     (auto-selected when stdin is not a TTY)
  moxxy login status                Show currently-stored OAuth credentials (no secrets printed)
  moxxy login logout <provider>     Remove stored OAuth credentials for a provider

After a successful login the credentials live in the encrypted vault
(~/.moxxy/vault.json). Set the active provider via moxxy.config.yaml:

  provider:
    name: openai-codex
`;

export async function runLoginCommand(argv: ParsedArgv): Promise<number> {
  const sub = argv.positional[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP);
    return sub ? 0 : 2;
  }
  if (sub === 'openai-codex') return await loginOpenAICodex(argv);
  if (sub === 'status') return await loginStatus(argv);
  if (sub === 'logout') return await loginLogout(argv);
  process.stderr.write(`${colors.red(`unknown subcommand: ${sub}`)}\n${HELP}`);
  return 2;
}

async function loginOpenAICodex(argv: ParsedArgv): Promise<number> {
  const { vault } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    skipProviderActivation: true,
  });
  // Pre-warm the vault before we open a TCP port / start polling. If the
  // vault prompts for a passphrase, we want that to happen synchronously
  // here — not racing the browser callback.
  await vault.open();

  // Headless mode triggers when:
  //   - stdin isn't a TTY (CI, ssh -T, docker exec without -t), OR
  //   - the user passes `--no-browser` (e.g. running on a remote box and
  //     wanting to complete the flow from their laptop's browser).
  const noBrowser = hasBoolFlag(argv, 'no-browser');
  const headless = noBrowser || process.stdin.isTTY !== true;

  return headless ? loginCodexDeviceFlow(vault) : loginCodexBrowserFlow(vault);
}

async function loginCodexBrowserFlow(
  vault: import('@moxxy/plugin-vault').VaultStore,
): Promise<number> {
  const {
    generatePKCE,
    generateState,
    buildAuthorizeUrl,
    exchangeCodeForTokens,
    DEFAULT_CALLBACK_PORT,
  } = await import('@moxxy/plugin-provider-openai-codex');

  const pkce = await generatePKCE();
  const state = generateState();
  const server = await startCallbackServer({ port: DEFAULT_CALLBACK_PORT, expectedState: state });
  const url = buildAuthorizeUrl(server.redirectUri, pkce, state);

  process.stdout.write(
    `\n${colors.bold('Sign in to ChatGPT to authorize moxxy')}\n\n` +
      `If your browser doesn't open automatically, paste this URL:\n\n  ${colors.cyan(url)}\n\n` +
      `Waiting for callback on ${colors.dim(server.redirectUri)} (5 min timeout)…\n\n`,
  );

  // Best-effort browser launch — never fatal if it fails.
  await tryOpenInBrowser(url);

  try {
    const code = await server.waitForCode(5 * 60 * 1000);
    const tokens = await exchangeCodeForTokens(code, server.redirectUri, pkce);
    await writeCodexTokens(vault, tokens);
    process.stdout.write(
      `${colors.green('✓ Login successful.')} ` +
        `Account: ${colors.bold(tokens.accountId ?? '(none)')}  ` +
        colors.dim(`token expires ${new Date(tokens.expires).toLocaleString()}`) +
        `\n\n` +
        `Set ${colors.cyan('provider.name: openai-codex')} in moxxy.config.yaml to use it.\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${colors.red('✗ Login failed:')} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    server.stop();
  }
}

async function loginCodexDeviceFlow(
  vault: import('@moxxy/plugin-vault').VaultStore,
): Promise<number> {
  const { startDeviceAuth, pollDeviceAuth } = await import('@moxxy/plugin-provider-openai-codex');

  let init;
  try {
    init = await startDeviceAuth();
  } catch (err) {
    process.stderr.write(
      `${colors.red('✗ Could not start device authorization:')} ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n${colors.bold('Sign in to ChatGPT (headless / device code flow)')}\n\n` +
      `  1. On any browser-capable device, open:\n` +
      `       ${colors.cyan(init.verificationUri)}\n\n` +
      `  2. Enter this code:\n` +
      `       ${colors.bold(colors.green(init.userCode))}\n\n` +
      `Polling every ${Math.round(init.intervalMs / 1000)}s (10 min timeout)…\n\n`,
  );

  try {
    const tokens = await pollDeviceAuth(init, { timeoutMs: 10 * 60 * 1000 });
    await writeCodexTokens(vault, tokens);
    process.stdout.write(
      `${colors.green('✓ Login successful.')} ` +
        `Account: ${colors.bold(tokens.accountId ?? '(none)')}  ` +
        colors.dim(`token expires ${new Date(tokens.expires).toLocaleString()}`) +
        `\n\n` +
        `Set ${colors.cyan('provider.name: openai-codex')} in moxxy.config.yaml to use it.\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${colors.red('✗ Login failed:')} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function loginStatus(argv: ParsedArgv): Promise<number> {
  const { vault } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    skipProviderActivation: true,
  });
  await vault.open();
  const tokens = await readCodexTokens(vault);
  if (!tokens) {
    process.stdout.write(
      `${colors.dim('openai-codex')}: ${colors.yellow('not logged in')}\n` +
        `  Run \`moxxy login openai-codex\` to sign in.\n`,
    );
    return 0;
  }
  const expired = tokens.expires < Date.now();
  process.stdout.write(
    `${colors.bold('openai-codex')}\n` +
      `  account:        ${tokens.accountId ?? colors.dim('(none)')}\n` +
      `  access expires: ${new Date(tokens.expires).toLocaleString()}` +
      (expired ? ` ${colors.red('(expired — will refresh on next call)')}` : '') +
      `\n  vault key:      ${colors.dim(CODEX_VAULT_KEY)}\n`,
  );
  return 0;
}

async function loginLogout(argv: ParsedArgv): Promise<number> {
  const provider = argv.positional[1];
  if (provider !== 'openai-codex') {
    process.stderr.write(
      `${colors.red(`logout: pass a provider name`)}\n  usage: moxxy login logout openai-codex\n`,
    );
    return 2;
  }
  const { vault } = await bootSessionWithConfig(argv, {
    skipKeyPrompt: true,
    skipProviderActivation: true,
  });
  await vault.open();
  const removed = await deleteCodexTokens(vault);
  if (removed) {
    process.stdout.write(`${colors.green('✓ Logged out.')} OAuth credentials removed from the vault.\n`);
    return 0;
  }
  process.stdout.write(`${colors.dim('No stored credentials for openai-codex.')}\n`);
  return 0;
}

async function tryOpenInBrowser(url: string): Promise<void> {
  // Use the OS-native "open this URL" command — no extra npm dependency
  // required. Each branch is a fire-and-forget; failure is fine.
  const { spawn } = await import('node:child_process');
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Silent fallback — user has the URL printed above.
  }
}
