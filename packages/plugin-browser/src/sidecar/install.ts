/**
 * Playwright lifecycle: import, launch, and one-shot auto-install of the
 * per-browser binary. Keeps the dispatch layer free of node:child_process
 * + Playwright-import noise.
 */

import { spawn } from 'node:child_process';
import type { BrowserKind, BrowserType, PageHandle, PlaywrightHandle } from './types.js';

export interface LaunchResult {
  handle: PlaywrightHandle;
  /** Set when the browser binary was auto-downloaded during this launch. */
  installNotice: string | null;
}

export async function importPlaywright(): Promise<{
  chromium: BrowserType;
  firefox: BrowserType;
  webkit: BrowserType;
}> {
  try {
    return (await import('playwright')) as never;
  } catch (err) {
    const e = new Error(
      `Playwright is not installed. Run \`pnpm add playwright\` (or \`npm i playwright\`) and then \`npx playwright install\` in the moxxy install dir.\n` +
        `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
    (e as Error & { kind?: string }).kind = 'init';
    throw e;
  }
}

/**
 * Try to launch the browser. If the binary isn't downloaded yet
 * (Playwright distinguishes the npm install from the per-browser
 * binary download), run `npx playwright install <which>` once and
 * retry. The install can take 30s–2min on the first run depending on
 * connection; we surface progress on stderr (parent forwards to the
 * logger) and return a one-shot notice for the first tool response.
 */
export async function launchWithAutoInstall(
  browserType: BrowserType,
  which: BrowserKind,
  headless: boolean,
): Promise<LaunchResult> {
  try {
    return { handle: await launchOnce(browserType, headless), installNotice: null };
  } catch (err) {
    if (!isMissingBrowserError(err)) throw err;
    process.stderr.write(
      `moxxy-browser: ${which} binary missing, running \`npx playwright install ${which}\` ` +
        `(one-time, ~150MB). This may take a minute…\n`,
    );
    try {
      await runPlaywrightInstall(which);
    } catch (installErr) {
      const msg = installErr instanceof Error ? installErr.message : String(installErr);
      const e = new Error(
        `Playwright browser auto-install failed: ${msg}. ` +
          `Run \`npx playwright install ${which}\` manually in the moxxy dir.`,
      );
      (e as Error & { kind?: string }).kind = 'init';
      throw e;
    }
    process.stderr.write(`moxxy-browser: install complete, retrying launch\n`);
    return {
      handle: await launchOnce(browserType, headless),
      installNotice: `Auto-installed Playwright ${which} browser (~150MB, one-time).`,
    };
  }
}

async function launchOnce(browserType: BrowserType, headless: boolean): Promise<PlaywrightHandle> {
  const browser = await browserType.launch({ headless });
  const context = (await browser.newContext()) as PlaywrightHandle['context'];
  const page = (await context.newPage()) as unknown as PageHandle;
  return { browser, context, page };
}

function isMissingBrowserError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Playwright's "Executable doesn't exist at …" launch error fires
  // when the npm package is installed but the per-browser binary
  // hasn't been downloaded. The message stays stable across versions.
  return /Executable doesn'?t exist at/i.test(err.message);
}

/**
 * Run `npx playwright install <which>` and stream its output to the
 * sidecar's stderr so the operator can watch progress. Resolves on
 * exit-0; rejects with the tail of stderr otherwise.
 */
function runPlaywrightInstall(which: BrowserKind): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'install', which], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    child.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });
    child.once('error', (err) => reject(err));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderrTail.trim() || '(no stderr)'}`));
    });
  });
}
