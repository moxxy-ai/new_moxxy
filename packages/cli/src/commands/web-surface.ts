import type { ChannelHandle } from '@moxxy/sdk';
import type { Session } from '@moxxy/core';
import type { MoxxyConfig } from '@moxxy/config';
import type { VaultStore } from '@moxxy/plugin-vault';

/**
 * Channels whose users are NOT on this machine, so a built view needs a public
 * URL (a tunnel) to be reachable. Local channels (tui, http on localhost) are
 * fine with the localhost URL and must NOT open a public tunnel by surprise.
 */
const REMOTE_CHANNELS = new Set(['telegram']);

export interface CoAttachWebOptions {
  /** The primary channel's name, or 'serve' for the bare runner. */
  readonly primary: string;
  readonly session: Session;
  readonly vault: VaultStore;
  readonly config: MoxxyConfig;
  /** User-facing notice sink (defaults to stdout). */
  readonly write?: (line: string) => void;
}

/**
 * Co-attach the web view surface to a primary channel's (or the runner's)
 * session so `present_view` renders and the agent can hand the user a URL —
 * automatically, no env vars. On by default; disable with
 * `channels.web.coAttach: false`. The primary channel's permission resolver
 * governs the shared session (we don't install the web channel's).
 *
 * Tunnel policy (no env): an explicit `channels.web.tunnel` wins; otherwise a
 * remote primary (Telegram) auto-selects cloudflared when installed and prompts
 * to install it when not; local primaries stay on the localhost URL.
 */
export async function coAttachWebSurface(opts: CoAttachWebOptions): Promise<ChannelHandle | null> {
  const { primary, session, vault, config } = opts;
  const write = opts.write ?? ((line: string) => process.stdout.write(line));
  if (primary === 'web') return null;
  // Opt-out for embedded runners (e.g. the desktop app, which owns
  // its own UI and just needs the unix-socket RPC). Without this,
  // multiple parallel runners all try to bind the web surface's
  // fixed port (4040) and the second one crashes with EADDRINUSE.
  if (process.env.MOXXY_NO_WEB_SURFACE === '1') return null;
  const webCfg = ((config.channels as Record<string, unknown> | undefined)?.web ?? {}) as Record<string, unknown>;
  if (webCfg.coAttach === false) return null; // explicit opt-out
  const def = session.channels.get('web');
  if (!def) return null;

  await resolveTunnel(primary, session, webCfg, write);

  try {
    const web = def.create({ cwd: process.cwd(), vault, logger: session.logger, options: webCfg });
    const handle = await web.start({ session } as never);
    const url = (web as { shareUrl?: string }).shareUrl;
    if (url) write(`  web surface  ${url}\n`);
    return handle;
  } catch (err) {
    session.logger.warn?.('web surface co-attach failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function resolveTunnel(
  primary: string,
  session: Session,
  webCfg: Record<string, unknown>,
  write: (line: string) => void,
): Promise<void> {
  // The web plugin's onInit has already applied any persisted (~/.moxxy/web.json)
  // or configured tunnel. Only auto-select here when nothing chose otherwise
  // (active is still the seeded localhost) AND the primary is remote.
  const activeName = session.tunnelProviders.getActive()?.name ?? 'localhost';
  if (activeName === 'localhost' && REMOTE_CHANNELS.has(primary) && session.tunnelProviders.list().some((p) => p.name === 'cloudflared')) {
    try {
      session.tunnelProviders.setActive('cloudflared');
    } catch {
      /* keep localhost */
    }
  }

  const active = session.tunnelProviders.getActive();
  if (active?.name === 'cloudflared' && active.isAvailable && !(await active.isAvailable())) {
    write(
      `  note: cloudflared isn't installed, so built views can't be opened from ${primary}.\n` +
        `        install it to share them remotely:  brew install cloudflared\n` +
        `        (falling back to the local URL for now)\n`,
    );
    session.tunnelProviders.setActive('localhost');
  }
}
