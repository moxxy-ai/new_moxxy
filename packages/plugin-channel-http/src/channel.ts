import { createServer, type Server } from 'node:http';
import { createAllowListResolver, denyByDefaultResolver } from '@moxxy/sdk';
import type { Session as CoreSession } from '@moxxy/core';
import type { ClientSession as Session } from '@moxxy/sdk';
import type {
  Channel,
  ChannelHandle,
  ChannelStartOptsBase,
  PermissionResolver,
} from '@moxxy/sdk';
import { routeRequest, type RouterContext } from './router.js';
import { OfficeAgentRuntime } from './office-agent-runtime.js';

export interface HttpChannelOptions {
  readonly port?: number;
  readonly host?: string;
  /** Bearer token required on every protected route. If unset, auth is disabled (dev-only). */
  readonly authToken?: string;
  /**
   * Tool names that the model is allowed to call without further interaction.
   * This is the entire permission story for HTTP — there's no human in the
   * loop to click "allow", so the operator declares trust upfront. Anything
   * not in this list is denied.
   */
  readonly allowedTools?: ReadonlyArray<string>;
  readonly logger?: {
    info?(msg: string, meta?: Record<string, unknown>): void;
    warn?(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface HttpStartOpts extends ChannelStartOptsBase {
  readonly session: Session;
}

export class HttpChannel implements Channel<HttpStartOpts> {
  readonly name = 'http';
  readonly permissionResolver: PermissionResolver;
  private readonly port: number;
  private readonly host: string;
  private readonly authToken: string | null;
  private readonly logger: HttpChannelOptions['logger'];
  private server: Server | null = null;

  constructor(opts: HttpChannelOptions = {}) {
    this.port = opts.port ?? 3737;
    this.host = opts.host ?? '127.0.0.1';
    this.authToken = opts.authToken ?? null;
    this.logger = opts.logger;
    this.permissionResolver = opts.allowedTools && opts.allowedTools.length > 0
      ? createAllowListResolver([...opts.allowedTools])
      : denyByDefaultResolver;
  }

  async start(startOpts: HttpStartOpts): Promise<ChannelHandle> {
    const officeAgents = new OfficeAgentRuntime(
      startOpts.session as unknown as CoreSession,
      this.logger as RouterContext['logger'],
    );
    const ctx: RouterContext = {
      session: startOpts.session,
      authToken: this.authToken,
      officeAgents,
      logger: this.logger as RouterContext['logger'],
    };

    const server = createServer(async (req, res) => {
      const handler = routeRequest(req);
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', path: req.url }));
        return;
      }
      try {
        await handler(req, res, ctx);
      } catch (err) {
        this.logger?.warn?.('http handler threw', { err: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal', message: String(err) }));
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      }
    });

    this.server = server;

    const listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        this.logger?.info?.('http channel listening', {
          host: this.host,
          port: this.port,
          authEnabled: this.authToken !== null,
        });
        resolve();
      });
    });

    await listening;

    const running = new Promise<void>((resolve) => {
      server.once('close', () => resolve());
    });

    return {
      running,
      stop: async () => {
        await officeAgents.archiveLiveAgents('session_closed');
        await new Promise<void>((resolve) => {
          if (!this.server) return resolve();
          this.server.close(() => resolve());
        });
      },
    };
  }
}
