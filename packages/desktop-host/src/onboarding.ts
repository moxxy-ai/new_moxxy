/**
 * Onboarding probes — purely informational, the renderer uses them
 * to decide whether to render an install / init wizard before the
 * chat surface. The actual save path (`saveProviderKey`) hands the
 * secret off to the CLI's own `vault set` so encryption stays the
 * CLI's responsibility.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { OnboardingStatus } from '@moxxy/desktop-ipc-contract';
import {
  augmentedPaths,
  resolveMoxxyCli,
  type CliInvocation,
} from './cli-resolver';
import { assertSafeProviderName } from './security';

export async function probeOnboarding(): Promise<OnboardingStatus> {
  const cli = resolveMoxxyCli({ extraPaths: augmentedPaths() });
  const cliInstalled = cli !== null;
  const cliPath = cli ? displayPath(cli) : null;

  const home = homedir();
  const prefs = await readPreferences(home);
  const activeProvider = prefs?.providerName ?? null;
  const vaultKeys = await readVaultKeys(home);

  const expectedKey = activeProvider
    ? `${activeProvider.toUpperCase().replace(/-/g, '_')}_API_KEY`
    : null;
  const hasProvider =
    activeProvider !== null &&
    expectedKey !== null &&
    vaultKeys.includes(expectedKey);

  return { cliInstalled, cliPath, hasProvider, activeProvider };
}

interface Preferences {
  providerName?: string;
  model?: string;
  mode?: string;
}

async function readPreferences(home: string): Promise<Preferences | null> {
  try {
    const body = await readFile(path.join(home, '.moxxy', 'preferences.json'), 'utf8');
    return JSON.parse(body) as Preferences;
  } catch {
    return null;
  }
}

export async function readVaultKeys(home: string): Promise<string[]> {
  try {
    const body = await readFile(path.join(home, '.moxxy', 'vault.json'), 'utf8');
    const doc = JSON.parse(body) as { entries?: Record<string, unknown> };
    return Object.keys(doc.entries ?? {});
  } catch {
    return [];
  }
}

/**
 * Pipe the secret into `moxxy vault set <NAME>_API_KEY`. We never
 * persist or log the value ourselves; the CLI owns its own KDF and
 * keychain integration.
 */
export async function saveProviderKey(provider: string, secret: string): Promise<void> {
  assertSafeProviderName(provider);
  const cli = resolveMoxxyCli({ extraPaths: augmentedPaths() });
  if (!cli) throw new Error('moxxy CLI not found');
  const key = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  await runCli(cli, ['vault', 'set', key], secret);
}

function runCli(cli: CliInvocation, args: string[], stdin?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child =
      cli.kind === 'direct'
        ? spawn(cli.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('node', [cli.entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited ${code ?? 'null'}: ${stderr.trim()}`));
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.write('\n');
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

function displayPath(cli: CliInvocation): string {
  return cli.kind === 'direct' ? cli.bin : cli.entry;
}
