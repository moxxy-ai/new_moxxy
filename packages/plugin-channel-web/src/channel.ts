import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAllowListResolver, bearerTokenMatches } from '@moxxy/sdk';
import type {
  Channel,
  ChannelHandle,
  ChannelStartOptsBase,
  ClientSession,
  PermissionResolver,
  TunnelHandle,
  TunnelProviderDef,
} from '@moxxy/sdk';
import { EventProjector } from './projector.js';
import { actionPrompt, type ClientFrame, type ServerFrame } from './protocol.js';

function isAddrInUse(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'EADDRINUSE'
  );
}

/** Best-effort: kill the process bound to a TCP port so the next
 *  bind succeeds. lsof + SIGTERM → SIGKILL grace. macOS / Linux. */
async function freeTcpPort(port: number): Promise<void> {
  if (process.platform === 'win32') return;
  const { spawn } = await import('node:child_process');
  const pids = await new Promise<ReadonlyArray<number>>((resolve) => {
    let out = '';
    try {
      const child = spawn('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout.on('data', (b) => {
        out += b.toString();
      });
      child.on('error', () => resolve([]));
      child.on('close', () => {
        const found = new Set<number>();
        for (const line of out.split('\n')) {
          const n = parseInt(line.trim(), 10);
          if (Number.isFinite(n) && n > 0) found.add(n);
        }
        resolve([...found]);
      });
    } catch {
      resolve([]);
    }
  });
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* may already be gone */
    }
  }
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      /* dead */
    }
  }
}

/** Where `scripts/build-web.mjs` writes the browser bundle (relative to dist/channel.js). */
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export interface WebChannelOptions {
  readonly port?: number;
  readonly host?: string;
  /** Token gating every request + the WS handshake. Generated if unset. */
  readonly authToken?: string;
  /** Tools the model may call without a human prompt (no clicker in this loop). */
  readonly allowedTools?: ReadonlyArray<string>;
  /** Resolve the session's active tunnel provider (injected by the CLI builder). */
  readonly getTunnel?: () => TunnelProviderDef | null;
  /**
   * Publish/clear the live surface so `present_view` can return the public URL
   * the agent relays to the user. Called with the surface on start, null on stop.
   */
  readonly publishSurface?: (surface: { url: string; nextViewId: () => string } | null) => void;
  /**
   * Publish/clear live controls so the agent's `web_set_tunnel` tool can switch
   * the tunnel without a restart. `retunnel` closes the current tunnel (no leak)
   * and re-opens via the now-active provider, returning the new share URL.
   */
  readonly publishControls?: (controls: WebSurfaceControls | null) => void;
  readonly logger?: {
    info?(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface WebSurfaceControls {
  retunnel(): Promise<string | null>;
}

export interface WebStartOpts extends ChannelStartOptsBase {
  readonly session: ClientSession;
}

export class WebChannel implements Channel<WebStartOpts> {
  readonly name = 'web';
  readonly permissionResolver: PermissionResolver;
  private port: number;
  private readonly host: string;
  private readonly token: string;
  private readonly logger: WebChannelOptions['logger'];
  private readonly getTunnel: WebChannelOptions['getTunnel'];
  private readonly publishSurface: WebChannelOptions['publishSurface'];
  private readonly publishControls: WebChannelOptions['publishControls'];
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  /** Built screens, keyed by name||viewId, replayed to a newly-connected browser. */
  private readonly views = new Map<string, ServerFrame>();
  private unsubscribe: (() => void) | null = null;
  private session: ClientSession | null = null;
  private busy = false;
  private controller: AbortController | null = null;
  private tunnel: TunnelHandle | null = null;
  private tunnelBase: string | null = null;
  private viewSeq = 0;

  constructor(opts: WebChannelOptions = {}) {
    this.port = opts.port ?? 4040;
    this.host = opts.host ?? '127.0.0.1';
    this.token = opts.authToken ?? randomBytes(16).toString('hex');
    this.logger = opts.logger;
    this.getTunnel = opts.getTunnel;
    this.publishSurface = opts.publishSurface;
    this.publishControls = opts.publishControls;
    // The interactive surface is the gate; tools still need an upfront
    // allow-list (no per-call clicker). Default to present_view + the read-only
    // fetch tools so apps can pull REAL data out of the box. Extend via
    // config.allowedTools. (When co-attached, the PRIMARY channel's resolver
    // governs instead — e.g. the TUI prompts per tool.)
    const allowed =
      opts.allowedTools && opts.allowedTools.length > 0
        ? [...opts.allowedTools]
        : ['present_view', 'web_fetch', 'browser_session'];
    this.permissionResolver = createAllowListResolver(allowed);
  }

  /** The local URL (token embedded). */
  get url(): string {
    return `http://${this.host}:${this.port}/?t=${this.token}`;
  }

  /** The URL to hand the user — the tunnel base if open, else local. */
  get shareUrl(): string {
    const base = this.tunnelBase ?? `http://${this.host}:${this.port}`;
    return `${base}/?t=${this.token}`;
  }

  async start(startOpts: WebStartOpts): Promise<ChannelHandle> {
    this.session = startOpts.session;
    const projector = new EventProjector();
    this.unsubscribe = startOpts.session.log.subscribe((event) => {
      for (const frame of projector.project(event)) {
        // Remember each screen so a browser that connects AFTER the agent built
        // the app (the normal flow: build in TUI/Telegram → open the link) still
        // sees it. Keyed by name||viewId so a re-render replaces in place.
        if (frame.kind === 'view') this.views.set(frame.name ?? frame.viewId, frame);
        this.broadcast(frame);
      }
    });

    const server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.server = server;

    // Validate the token at the handshake so a bad token is rejected with 401
    // and the client never opens (the token is the only public-internet gate).
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: (info: { req: IncomingMessage }) => this.validToken(info.req.url),
    });
    this.wss = wss;
    wss.on('connection', (ws) => this.onConnection(ws));

    await this.bindServerWithRetry(server);

    await this.openTunnel();
    this.publishSurface?.({ url: this.shareUrl, nextViewId: () => `v_srv_${++this.viewSeq}` });
    this.publishControls?.({ retunnel: () => this.retunnel() });

    const running = new Promise<void>((resolve) => server.once('close', () => resolve()));
    return { running, stop: () => this.stop() };
  }

  /**
   * Bind the HTTP server, with one round of recovery if the port is
   * already in use. A stale `moxxy serve` from a prior install often
   * leaves 4040 bound even after its unix socket has been released;
   * killing whatever PID holds the port lets the fresh server boot
   * cleanly instead of crashing with EADDRINUSE.
   */
  private async bindServerWithRetry(server: ReturnType<typeof createServer>): Promise<void> {
    const tryListen = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const addr = server.address();
          if (addr && typeof addr === 'object') this.port = (addr as AddressInfo).port;
          this.logger?.info?.('web channel listening', { url: this.url });
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.port, this.host);
      });

    try {
      await tryListen();
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
      this.logger?.warn?.(`web channel port ${this.port} in use; freeing and retrying`);
      await freeTcpPort(this.port).catch(() => undefined);
      await tryListen();
    }
  }

  /**
   * (Re-)open the tunnel via the active provider, closing any prior one FIRST so
   * a switch never leaks a subprocess. Non-fatal: on failure (e.g. cloudflared
   * not installed) we fall back to the local URL.
   */
  private async openTunnel(): Promise<void> {
    if (this.tunnel) {
      try {
        await this.tunnel.close();
      } catch {
        /* ignore */
      }
      this.tunnel = null;
      this.tunnelBase = null;
    }
    const provider = this.getTunnel?.() ?? null;
    if (!provider || provider.name === 'localhost') return;
    try {
      this.tunnel = await provider.open({ port: this.port, host: this.host });
      this.tunnelBase = this.tunnel.url;
      this.logger?.info?.('web surface tunnel open', { provider: provider.name, url: this.shareUrl });
    } catch (err) {
      this.logger?.warn?.('web surface tunnel failed; using local URL', { provider: provider.name, err: String(err) });
    }
  }

  /** Switch tunnels live (agent's web_set_tunnel) and republish the surface URL. */
  private async retunnel(): Promise<string | null> {
    await this.openTunnel();
    this.publishSurface?.({ url: this.shareUrl, nextViewId: () => `v_srv_${++this.viewSeq}` });
    return this.shareUrl;
  }

  private async stop(): Promise<void> {
    this.publishSurface?.(null);
    this.publishControls?.(null);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.abort();
    if (this.tunnel) {
      try {
        await this.tunnel.close();
      } catch {
        /* ignore */
      }
      this.tunnel = null;
      this.tunnelBase = null;
    }
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private validToken(reqUrl: string | undefined): boolean {
    try {
      // Constant-time compare so the token isn't recoverable byte-by-byte via
      // response timing (this is the only public-internet gate).
      const presented = new URL(reqUrl ?? '/', 'http://localhost').searchParams.get('t');
      return bearerTokenMatches(presented, this.token);
    } catch {
      return false;
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (!this.validToken(req.url)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized — open the tokenized URL the agent gave you');
        return;
      }
      await this.serveFile(res, 'index.html', 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && pathname === '/app.js') {
      await this.serveFile(res, 'app.js', 'text/javascript; charset=utf-8');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  private async serveFile(res: ServerResponse, name: string, contentType: string): Promise<void> {
    try {
      const buf = await readFile(path.join(PUBLIC_DIR, name));
      res.writeHead(200, { 'content-type': contentType });
      res.end(buf);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('web surface bundle missing — run `pnpm --filter @moxxy/plugin-channel-web build`');
    }
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', (data: unknown) => this.onMessage(ws, data));
    this.send(ws, { kind: 'hello' });
    // Replay already-built screens so a browser opening the link AFTER the agent
    // built the app sees it immediately (no "No view yet").
    for (const frame of this.views.values()) this.send(ws, frame);
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
    } catch {
      return;
    }
    if (frame.kind === 'prompt') {
      if (frame.text.trim()) void this.drive(frame.text);
      return;
    }
    if (frame.kind === 'action') {
      if (this.busy) {
        this.send(ws, { kind: 'ack', actionId: frame.actionId, accepted: false, reason: 'busy' });
        return;
      }
      this.send(ws, { kind: 'ack', actionId: frame.actionId, accepted: true });
      void this.drive(actionPrompt(frame.action, frame.formValues));
    }
  }

  private async drive(prompt: string): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    this.controller = new AbortController();
    try {
      // Rendering happens via the log subscription; we only need to drain the
      // iterator so the turn actually executes.
      for await (const _event of this.session.runTurn(prompt, { signal: this.controller.signal })) {
        void _event;
      }
    } catch (err) {
      this.broadcast({ kind: 'status', turnId: '', phase: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  private broadcast(frame: ServerFrame): void {
    const s = JSON.stringify(frame);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(s);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* ignore */
    }
  }
}
