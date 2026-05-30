/**
 * Security helpers for the Electron main process.
 *
 * The renderer is untrusted from the main process's point of view: a
 * single XSS (e.g. via rendered markdown) would otherwise inherit the
 * main process's filesystem + child-process authority. These helpers
 * gate the dangerous edges — IPC input validation, navigation lockdown,
 * a Clerk-compatible Content-Security-Policy, and secret redaction for
 * the diagnostics the renderer is allowed to see.
 */

import type { BrowserWindow, Session } from 'electron';

// ---- IPC input validation -------------------------------------------------

/**
 * Provider names are interpolated into vault key names
 * (`<PROVIDER>_API_KEY`) and passed as argv tokens to
 * `moxxy login <provider>` / `moxxy vault set`. Confine them to a strict
 * slug so a compromised renderer cannot inject a CLI flag (`--foo`),
 * traverse the vault namespace (`../`), or smuggle a path separator.
 */
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function isSafeProviderName(provider: string): boolean {
  return PROVIDER_NAME.test(provider);
}

export function assertSafeProviderName(provider: string): void {
  if (typeof provider !== 'string' || !PROVIDER_NAME.test(provider)) {
    throw new Error(`invalid provider name: ${JSON.stringify(provider)}`);
  }
}

/**
 * Only ever hand http/https URLs to the OS via `shell.openExternal`.
 * `file://`, `javascript:`, and custom-protocol URIs handed to the OS
 * shell are RCE-adjacent on Windows/macOS.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function assertSafeExternalUrl(url: string): void {
  if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
    throw new Error(`refusing to open non-http(s) URL: ${JSON.stringify(url)}`);
  }
}

// ---- secret redaction -----------------------------------------------------

/**
 * Best-effort scrub of secrets from a runner log line before it crosses
 * the IPC boundary into the renderer (where it is shown in the
 * connection diagnostics). A plugin that accidentally echoes a key to
 * stdout must not leak it into untrusted renderer memory.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic secret keys
  /\b[a-z]{2,4}_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe/Clerk-style scoped keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // bearer tokens
  /\beyJ[A-Za-z0-9._-]{20,}/g, // JWTs
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE))\b\s*[=:]\s*\S+/gi, // KEY=value
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, label?: string) =>
      label ? `${label}=«redacted»` : '«redacted»',
    );
  }
  return out;
}

// ---- navigation lockdown --------------------------------------------------

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    // file:// documents share an opaque origin; treat any file:// → file://
    // navigation (e.g. between bundled HTML entries) as same-origin.
    if (ua.protocol === 'file:' && ub.protocol === 'file:') return true;
    return ua.origin === ub.origin;
  } catch {
    return false;
  }
}

/**
 * Refuse to navigate the top frame away from the app's own origin and
 * (unless the window installs its own handler) deny `window.open`. An
 * XSS that tries to point the window at a remote page or spawn a
 * privileged popup is stopped here. Hash routing (`#focus`) and the
 * Clerk OAuth popups (which open via the main window's own
 * `setWindowOpenHandler`) are unaffected — those are in-page or handled
 * explicitly.
 */
export function lockDownNavigation(
  win: BrowserWindow,
  opts: { readonly keepWindowOpenHandler?: boolean } = {},
): void {
  const wc = win.webContents;
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (!sameOrigin(url, wc.getURL())) event.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (event) => event.preventDefault());
  if (!opts.keepWindowOpenHandler) {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
}

// ---- Content-Security-Policy ----------------------------------------------

/**
 * Clerk-compatible CSP for the packaged app. Scripts stay strict
 * (`'self'` + the Clerk/Cloudflare-Turnstile origins clerk-js needs —
 * no `'unsafe-inline'`/`'unsafe-eval'` because the bundle ships only
 * external module scripts). Styles allow `'unsafe-inline'` because the
 * UI uses inline style objects + the splash `<style>` block + Google
 * Fonts.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
  "worker-src 'self' blob:",
  "frame-src https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Inject the CSP onto the app's own `file://` document responses only.
 * Third-party responses (the Clerk CDN, Google Fonts, and especially the
 * OAuth popups that load accounts.google.com / github.com) are left
 * untouched — slapping our CSP on them would break sign-in. Dev is
 * skipped entirely: Vite's HMR needs `'unsafe-eval'` + ws: and a strict
 * policy would break the dev server.
 */
export function installContentSecurityPolicy(
  session: Session,
  opts: { readonly isDev: boolean },
): void {
  if (opts.isDev) return;
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith('file://')) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_DIRECTIVES],
      },
    });
  });
}
