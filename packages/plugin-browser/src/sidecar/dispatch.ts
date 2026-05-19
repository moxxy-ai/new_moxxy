/**
 * JSON-RPC dispatch table for the sidecar. Each `method` here corresponds
 * one-to-one with the wire-format methods documented in `sidecar.ts`.
 */

import { importPlaywright, launchWithAutoInstall } from './install.js';
import {
  badParams,
  errMsg,
  type BrowserKind,
  type Err,
  type PlaywrightHandle,
  type Reply,
  type Req,
} from './types.js';

export interface SidecarState {
  handle: PlaywrightHandle | null;
  /**
   * Set after a successful auto-install of browser binaries so the next
   * tool result can carry a `notice` letting the user/model know the
   * one-time download happened. Cleared once the notice has been
   * delivered (handed to the reply once, then forgotten).
   */
  pendingInstallNotice: string | null;
}

async function ensurePlaywright(
  state: SidecarState,
  opts: { browser?: BrowserKind; headless?: boolean },
): Promise<PlaywrightHandle> {
  if (state.handle) return state.handle;
  const pw = await importPlaywright();
  const which = opts.browser ?? 'chromium';
  const browserType = pw[which];
  const { handle, installNotice } = await launchWithAutoInstall(browserType, which, opts.headless ?? true);
  state.handle = handle;
  if (installNotice) state.pendingInstallNotice = installNotice;
  return state.handle;
}

export async function teardown(state: SidecarState): Promise<void> {
  if (!state.handle) return;
  try {
    await state.handle.context.close();
    await state.handle.browser.close();
  } catch {
    /* ignore */
  }
  state.handle = null;
}

export async function dispatch(state: SidecarState, req: Req): Promise<Reply> {
  try {
    return await dispatchInner(state, req);
  } catch (err) {
    const kind = (err as Error & { kind?: string }).kind;
    return {
      id: req.id,
      ok: false,
      error: { message: errMsg(err), kind: (kind as Err['error']['kind']) ?? 'unknown' },
    };
  }
}

async function dispatchInner(state: SidecarState, req: Req): Promise<Reply> {
  switch (req.method) {
    case 'init': {
      const opts = (req.params ?? {}) as { browser?: BrowserKind; headless?: boolean };
      await ensurePlaywright(state, opts);
      return { id: req.id, ok: true, result: { ready: true } };
    }
    case 'goto': {
      const h = await ensurePlaywright(state, {});
      const { url, waitUntil, timeoutMs } = (req.params ?? {}) as {
        url: string;
        waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
        timeoutMs?: number;
      };
      if (!url) throw badParams('url is required');
      try {
        await h.page.goto(url, { waitUntil: waitUntil ?? 'domcontentloaded', timeout: timeoutMs ?? 30_000 });
      } catch (err) {
        return { id: req.id, ok: false, error: { message: errMsg(err), kind: 'navigation' } };
      }
      return { id: req.id, ok: true, result: { url: h.page.url() } };
    }
    case 'click': {
      const h = await ensurePlaywright(state, {});
      const { selector, timeoutMs } = (req.params ?? {}) as { selector: string; timeoutMs?: number };
      if (!selector) throw badParams('selector is required');
      await h.page.click(selector, { timeout: timeoutMs ?? 10_000 });
      return { id: req.id, ok: true };
    }
    case 'fill': {
      const h = await ensurePlaywright(state, {});
      const { selector, value, timeoutMs } = (req.params ?? {}) as {
        selector: string;
        value: string;
        timeoutMs?: number;
      };
      if (!selector) throw badParams('selector is required');
      await h.page.fill(selector, value ?? '', { timeout: timeoutMs ?? 10_000 });
      return { id: req.id, ok: true };
    }
    case 'text': {
      const h = await ensurePlaywright(state, {});
      const { selector } = (req.params ?? {}) as { selector?: string };
      if (selector) {
        const text = await h.page.textContent(selector);
        return { id: req.id, ok: true, result: text ?? '' };
      }
      // Whole-document text via evaluate
      const text = (await h.page.evaluate('document.body ? document.body.innerText : ""')) as string;
      return { id: req.id, ok: true, result: text };
    }
    case 'html': {
      const h = await ensurePlaywright(state, {});
      const html = await h.page.content();
      return { id: req.id, ok: true, result: html };
    }
    case 'screenshot': {
      const h = await ensurePlaywright(state, {});
      const { fullPage } = (req.params ?? {}) as { fullPage?: boolean };
      const buf = await h.page.screenshot({ fullPage: fullPage ?? false });
      return { id: req.id, ok: true, result: { mediaType: 'image/png', base64: buf.toString('base64') } };
    }
    case 'eval': {
      const h = await ensurePlaywright(state, {});
      const { expression } = (req.params ?? {}) as { expression: string };
      if (!expression) throw badParams('expression is required');
      const value = await h.page.evaluate(expression);
      return { id: req.id, ok: true, result: value };
    }
    case 'url': {
      const h = await ensurePlaywright(state, {});
      return { id: req.id, ok: true, result: h.page.url() };
    }
    case 'close': {
      await teardown(state);
      return { id: req.id, ok: true };
    }
    default:
      return {
        id: req.id,
        ok: false,
        error: { message: `unknown method: ${req.method}`, kind: 'runtime' },
      };
  }
}
