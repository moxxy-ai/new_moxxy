import { spawn, type StdioOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverPlugins, readSessionIndex, silentLogger, type Session, type SessionMeta } from '@moxxy/core';
import { HttpChannel } from '@moxxy/plugin-channel-http';
import { TuiChannel } from '@moxxy/plugin-cli';
import {
  isUiPluginManifest,
  moxxyPackageSchema,
  type ResolvedPluginManifest,
  type ChannelHandle,
  type PermissionResolver,
} from '@moxxy/sdk';
import { userPluginsDir } from '@moxxy/plugin-plugins-admin';
import type { ParsedArgv } from '../argv.js';
import { bootSessionWithConfig, hasBoolFlag, helpRequested, stringFlag } from '../argv-helpers.js';
import { colors } from '../colors.js';
import { printError } from '../errors.js';

const HELP = `moxxy ui open — start a UI plugin in the foreground

  moxxy ui open <package-or-path>
  moxxy ui open <package> --port 17901 --api-port 3737 --open
  moxxy ui open <package> --tui --open
  moxxy ui open <package> --session <id>
  moxxy ui open <package> --new-session
  moxxy ui open <package> -- --theme dark --debug    forward args to UI

Aliases: \`moxxy marketplace open …\` runs the same flow.
`;

export interface StartUiPluginOptions {
  readonly manifest: ResolvedPluginManifest;
  readonly uiPort?: number;
  readonly apiPort: number;
  readonly token: string;
  readonly extraEnv?: Record<string, string | undefined>;
  readonly stdio?: StdioOptions;
  /** Extra argv forwarded to the UI plugin child process (after entry). */
  readonly extraArgs?: ReadonlyArray<string>;
}

export interface StartUiPluginResult {
  readonly exitCode: number;
}

export interface UiPluginProcessHandle {
  readonly running: Promise<StartUiPluginResult>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export type SessionSelectionResult =
  | { readonly mode: 'new' }
  | { readonly mode: 'resume'; readonly sessionId: string };

export interface SessionSelectionServerHandle {
  readonly selection: Promise<SessionSelectionResult>;
  readonly url: string;
  stop(): Promise<void>;
}

export interface StartSessionSelectionServerOptions {
  readonly apiPort: number;
  readonly token: string;
  readonly host?: string;
  readonly readSessions?: () => Promise<ReadonlyArray<SessionMeta>>;
}

export interface UiPluginHostOptions extends StartUiPluginOptions {
  readonly session: Session;
  readonly bridge: {
    readonly permissionResolver: PermissionResolver;
    start(opts: { session: Session }): Promise<ChannelHandle>;
  };
  readonly withTui?: boolean;
  readonly preferBridgePermissions?: boolean;
  readonly model?: string;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly open?: boolean;
  readonly handleSignals?: boolean;
  readonly createTuiChannel?: () => {
    readonly permissionResolver: PermissionResolver;
    start(opts: { session: Session; model?: string }): Promise<ChannelHandle>;
  };
  readonly startUiProcess?: (opts: StartUiPluginOptions) => UiPluginProcessHandle;
}

export interface UiPluginSessionSelectionHostOptions extends StartUiPluginOptions {
  readonly sessionPicker: Pick<SessionSelectionServerHandle, 'selection' | 'stop'>;
  readonly bootSession: (selection: SessionSelectionResult) => Promise<Session>;
  readonly createBridge: (session: Session) => {
    readonly permissionResolver: PermissionResolver;
    start(opts: { session: Session }): Promise<ChannelHandle>;
  };
  readonly withTui?: boolean;
  readonly preferBridgePermissions?: boolean;
  readonly model?: string;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly open?: boolean;
  readonly handleSignals?: boolean;
  readonly createTuiChannel?: () => {
    readonly permissionResolver: PermissionResolver;
    start(opts: { session: Session; model?: string }): Promise<ChannelHandle>;
  };
  readonly startUiProcess?: (opts: StartUiPluginOptions) => UiPluginProcessHandle;
}

export function isStartableUiPluginManifest(manifest: Pick<ResolvedPluginManifest, 'kind'>): boolean {
  return isUiPluginManifest(manifest);
}

export async function startSessionSelectionServer(
  opts: StartSessionSelectionServerOptions,
): Promise<SessionSelectionServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const readSessions = opts.readSessions ?? readSessionIndex;
  let selected = false;
  let closed = false;
  let resolveSelection!: (selection: SessionSelectionResult) => void;
  const selection = new Promise<SessionSelectionResult>((resolve) => {
    resolveSelection = resolve;
  });

  const server = createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (req.method === 'GET' && pathname === '/v1/health') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    if (pathname !== '/v1/session-selection') {
      writeJson(res, 404, { error: 'not_found', path: req.url });
      return;
    }
    if (!hasBearer(req.headers.authorization, opts.token)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET') {
      writeJson(res, 200, {
        status: selected ? 'ready' : 'selecting',
        sessions: selected ? [] : (await readSessions())
          .filter(isSelectableSession)
          .map(sessionMetaToSelectionOption),
      });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (selected) {
      writeJson(res, 409, { error: 'already_selected' });
      return;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      writeJson(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const mode = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).mode : null;
    if (mode === 'new') {
      selected = true;
      writeJson(res, 200, { status: 'ready', sessions: [] });
      setImmediate(() => resolveSelection({ mode: 'new' }));
      return;
    }
    if (mode === 'resume') {
      const sessionId = (body as Record<string, unknown>).session_id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        writeJson(res, 400, { error: 'bad_request', message: 'session_id is required' });
        return;
      }
      const sessions = await readSessions();
      if (!sessions.some((entry) => entry.id === sessionId)) {
        writeJson(res, 404, { error: 'not_found', message: `session not found: ${sessionId}` });
        return;
      }
      selected = true;
      writeJson(res, 200, { status: 'ready', sessions: [] });
      setImmediate(() => resolveSelection({ mode: 'resume', sessionId }));
      return;
    }

    writeJson(res, 400, { error: 'bad_request', message: 'mode must be "new" or "resume"' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.apiPort, host, () => resolve());
  });

  return {
    selection,
    url: `http://${host}:${opts.apiPort}`,
    stop: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export function startUiPluginProcess(opts: StartUiPluginOptions): UiPluginProcessHandle {
  const uiPort = opts.uiPort ?? opts.manifest.port ?? 17901;
  const uiHost = opts.manifest.host ?? '127.0.0.1';
  const entry = path.resolve(opts.manifest.packagePath, opts.manifest.entry);
  const extraArgs = opts.extraArgs ? [...opts.extraArgs] : [];
  const child = spawn(process.execPath, [entry, ...extraArgs], {
    cwd: opts.manifest.packagePath,
    env: {
      ...process.env,
      ...opts.extraEnv,
      PORT: String(uiPort),
      HOST: uiHost,
      MOXXY_PLUGIN_PORT: String(uiPort),
      MOXXY_PLUGIN_HOST: uiHost,
      MOXXY_API_URL: `http://127.0.0.1:${opts.apiPort}`,
      MOXXY_TOKEN: opts.token,
      MOXXY_PLUGIN_NAME: opts.manifest.packageName,
      MOXXY_HOME: opts.extraEnv?.MOXXY_HOME ?? process.env.MOXXY_HOME ?? path.join(os.homedir(), '.moxxy'),
    },
    stdio: opts.stdio ?? 'inherit',
  });

  let settled = false;
  const running = new Promise<StartUiPluginResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      settled = true;
      if (signal) resolve({ exitCode: 0 });
      else resolve({ exitCode: code ?? 0 });
    });
  });

  return {
    running,
    stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (!settled && child.exitCode === null) {
        child.kill(signal);
      }
      await running.catch(() => undefined);
    },
  };
}

export async function startUiPlugin(opts: StartUiPluginOptions): Promise<StartUiPluginResult> {
  return await startUiPluginProcess(opts).running;
}

export async function startUiPluginHost(opts: UiPluginHostOptions): Promise<StartUiPluginResult> {
  const out = opts.stdout ?? process.stdout;
  const uiPort = opts.uiPort ?? opts.manifest.port ?? 17901;
  const uiHost = opts.manifest.host ?? '127.0.0.1';
  const uiUrl = `http://${uiHost}:${uiPort}`;
  const label = opts.manifest.title ?? 'ui plugin';
  const handles: ChannelHandle[] = [];
  let uiProcess: UiPluginProcessHandle | null = null;
  let stopping = false;

  const stopAll = async (signal: NodeJS.Signals | 'normal'): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (uiProcess) await uiProcess.stop(signal === 'normal' ? 'SIGTERM' : signal).catch(() => undefined);
    for (const handle of [...handles].reverse()) {
      await handle.stop(signal).catch(() => undefined);
    }
    await opts.session.close(signal === 'normal' ? undefined : signal).catch(() => undefined);
  };

  const onSigint = () => void stopAll('SIGINT');
  const onSigterm = () => void stopAll('SIGTERM');
  if (opts.handleSignals) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  try {
    opts.session.setPermissionResolver(opts.bridge.permissionResolver);
    handles.push(await opts.bridge.start({ session: opts.session }));

    let tuiRunning: Promise<StartUiPluginResult> | null = null;
    if (opts.withTui) {
      const tui = opts.createTuiChannel?.() ?? new TuiChannel();
      if (!opts.preferBridgePermissions) {
        opts.session.setPermissionResolver(tui.permissionResolver);
      }
      const handle = await tui.start({
        session: opts.session,
        ...(opts.model ? { model: opts.model } : {}),
      });
      handles.push(handle);
      tuiRunning = handle.running.then(() => ({ exitCode: 0 }));
    }

    out.write(
      `${colors.bold(label)}  ${colors.dim(uiUrl)}\n` +
        `${colors.dim('bridge api: http://127.0.0.1:' + opts.apiPort)}\n` +
        (opts.withTui ? `${colors.dim('tui: same session as ' + label)}\n` : ''),
    );

    if (opts.open) openBrowser(uiUrl);

    const startProcess = opts.startUiProcess ?? startUiPluginProcess;
    uiProcess = startProcess({
      manifest: opts.manifest,
      uiPort,
      apiPort: opts.apiPort,
      token: opts.token,
      extraEnv: opts.extraEnv,
      stdio: opts.stdio ?? (opts.withTui ? 'ignore' : 'inherit'),
      ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
    });

    const result = await Promise.race([
      uiProcess.running,
      ...(tuiRunning ? [tuiRunning] : []),
    ]);
    await stopAll('normal');
    return result;
  } finally {
    if (opts.handleSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
    await stopAll('normal');
  }
}

export async function startUiPluginHostWithSessionSelection(
  opts: UiPluginSessionSelectionHostOptions,
): Promise<StartUiPluginResult> {
  const out = opts.stdout ?? process.stdout;
  const uiPort = opts.uiPort ?? opts.manifest.port ?? 17901;
  const uiHost = opts.manifest.host ?? '127.0.0.1';
  const uiUrl = `http://${uiHost}:${uiPort}`;
  const label = opts.manifest.title ?? 'ui plugin';
  const handles: ChannelHandle[] = [];
  let uiProcess: UiPluginProcessHandle | null = null;
  let session: Session | null = null;
  let stopping = false;

  const stopAll = async (signal: NodeJS.Signals | 'normal'): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (uiProcess) await uiProcess.stop(signal === 'normal' ? 'SIGTERM' : signal).catch(() => undefined);
    await opts.sessionPicker.stop().catch(() => undefined);
    for (const handle of [...handles].reverse()) {
      await handle.stop(signal).catch(() => undefined);
    }
    if (session) await session.close(signal === 'normal' ? undefined : signal).catch(() => undefined);
  };

  const onSigint = () => void stopAll('SIGINT');
  const onSigterm = () => void stopAll('SIGTERM');
  if (opts.handleSignals) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  try {
    out.write(
      `${colors.bold(label)}  ${colors.dim(uiUrl)}\n` +
        `${colors.dim('bridge api: http://127.0.0.1:' + opts.apiPort)}\n` +
        `${colors.dim('session picker: waiting for ' + label + ' selection')}\n`,
    );

    if (opts.open) openBrowser(uiUrl);

    const startProcess = opts.startUiProcess ?? startUiPluginProcess;
    uiProcess = startProcess({
      manifest: opts.manifest,
      uiPort,
      apiPort: opts.apiPort,
      token: opts.token,
      extraEnv: opts.extraEnv,
      stdio: opts.stdio ?? (opts.withTui ? 'ignore' : 'inherit'),
      ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
    });

    const first = await Promise.race([
      opts.sessionPicker.selection.then((selection) => ({ kind: 'selection' as const, selection })),
      uiProcess.running.then((result) => ({ kind: 'ui-exit' as const, result })),
    ]);
    if (first.kind === 'ui-exit') {
      await stopAll('normal');
      return first.result;
    }

    await opts.sessionPicker.stop();
    session = await opts.bootSession(first.selection);
    const bridge = opts.createBridge(session);
    session.setPermissionResolver(bridge.permissionResolver);
    handles.push(await bridge.start({ session }));

    let tuiRunning: Promise<StartUiPluginResult> | null = null;
    if (opts.withTui) {
      const tui = opts.createTuiChannel?.() ?? new TuiChannel();
      if (!opts.preferBridgePermissions) {
        session.setPermissionResolver(tui.permissionResolver);
      }
      const handle = await tui.start({
        session,
        ...(opts.model ? { model: opts.model } : {}),
      });
      handles.push(handle);
      tuiRunning = handle.running.then(() => ({ exitCode: 0 }));
    }

    const result = await Promise.race([
      uiProcess.running,
      ...(tuiRunning ? [tuiRunning] : []),
    ]);
    await stopAll('normal');
    return result;
  } finally {
    if (opts.handleSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
    await stopAll('normal');
  }
}

export async function runPluginStartCommand(argv: ParsedArgv): Promise<number> {
  if (helpRequested(argv)) {
    process.stdout.write(HELP);
    return 0;
  }

  const requested = argv.positional[1];
  if (!requested) {
    process.stdout.write(HELP);
    return 2;
  }

  let manifest: ResolvedPluginManifest;
  try {
    manifest = await resolveUiManifest(requested, process.cwd());
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let apiPort: number;
  let uiPort: number;
  try {
    apiPort = parsePort(stringFlag(argv, 'api-port'), manifest.apiPort ?? 3737);
    uiPort = parsePort(stringFlag(argv, 'port'), manifest.port ?? 17901);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // CLI flag wins over manifest; default = manifest.openInBrowser ?? true.
  const openInBrowser = hasBoolFlag(argv, 'no-open')
    ? false
    : argv.flags.open === true
      ? true
      : manifest.openInBrowser ?? true;
  const token = randomBytes(24).toString('hex');
  const explicitSessionId = stringFlag(argv, 'session') ?? stringFlag(argv, 's');
  const forceNewSession = hasBoolFlag(argv, 'new-session');
  const allowedTools = parseList(stringFlag(argv, 'allow-tools'));

  if (explicitSessionId && forceNewSession) {
    printError('Use either --session <id> or --new-session, not both.');
    return 1;
  }

  try {
    await assertTcpPortAvailable(uiPort, 'UI plugin');
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const createBridge = (session: Session) => new HttpChannel({
    port: apiPort,
    host: '127.0.0.1',
    authToken: token,
    allowedTools,
    interactivePermissions: !allowedTools,
    logger: session.logger,
  });

  const bootSelectedSession = async (selection: SessionSelectionResult): Promise<Session> => {
    const { session } = await bootSessionWithConfig(argv, {
      skipKeyPrompt: true,
      tolerateNoProvider: true,
      ...(selection.mode === 'resume' ? { resumeSessionId: selection.sessionId } : {}),
    });
    return session;
  };

  const extraArgs = argv.passthrough.length > 0 ? argv.passthrough : undefined;

  try {
    if (!explicitSessionId && !forceNewSession) {
      const sessionPicker = await startSessionSelectionServer({
        apiPort,
        token,
      });
      const result = await startUiPluginHostWithSessionSelection({
        sessionPicker,
        bootSession: bootSelectedSession,
        createBridge,
        manifest,
        uiPort,
        apiPort,
        token,
        withTui: hasBoolFlag(argv, 'tui'),
        preferBridgePermissions: !allowedTools,
        model: stringFlag(argv, 'model'),
        open: openInBrowser,
        handleSignals: true,
        ...(extraArgs ? { extraArgs } : {}),
      });
      return result.exitCode;
    }

    const session = await bootSelectedSession(
      explicitSessionId ? { mode: 'resume', sessionId: explicitSessionId } : { mode: 'new' },
    );
    const result = await startUiPluginHost({
      session,
      bridge: createBridge(session),
      manifest,
      uiPort,
      apiPort,
      token,
      withTui: hasBoolFlag(argv, 'tui'),
      preferBridgePermissions: !allowedTools,
      model: stringFlag(argv, 'model'),
      open: openInBrowser,
      handleSignals: true,
      ...(extraArgs ? { extraArgs } : {}),
    });
    return result.exitCode;
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function resolveUiManifest(requested: string, cwd: string): Promise<ResolvedPluginManifest> {
  if (looksLikePath(requested)) {
    return readPackageManifest(path.resolve(cwd, requested));
  }

  const pluginsDir = userPluginsDir();
  const manifests = await discoverPlugins({
    cwd,
    logger: silentLogger,
    extraPaths: [pluginsDir, path.join(pluginsDir, 'node_modules')],
  });
  const manifest = manifests.find((entry) => entry.packageName === requested);
  if (!manifest) throw new Error(`UI plugin not found: ${requested}. Run \`moxxy marketplace add ${requested}\` first.`);
  if (!isStartableUiPluginManifest(manifest)) throw new Error(`${requested} is not a UI plugin`);
  return manifest;
}

async function readPackageManifest(packagePath: string): Promise<ResolvedPluginManifest> {
  const pkgJsonPath = path.join(packagePath, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as {
    name?: string;
    version?: string;
    moxxy?: unknown;
  };
  const parsed = moxxyPackageSchema.parse(pkg.moxxy);
  if (!pkg.name) throw new Error(`package.json at ${pkgJsonPath} has no name`);
  if (!parsed.plugin) throw new Error(`${pkg.name} has no moxxy.plugin manifest`);
  const manifest: ResolvedPluginManifest = {
    ...parsed.plugin,
    packageName: pkg.name,
    packageVersion: pkg.version ?? '0.0.0',
    packagePath,
    ...(parsed.requirements ? { requirements: parsed.requirements } : {}),
  };
  if (!isStartableUiPluginManifest(manifest)) throw new Error(`${pkg.name} is not a UI plugin`);
  return manifest;
}

function looksLikePath(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('~');
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

async function assertTcpPortAvailable(port: number, label: string): Promise<void> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `${label} port ${port} is already in use. Stop the existing process or choose another port with --port.`,
          ),
        );
        return;
      }
      reject(err);
    });
    server.listen(port, () => {
      server.close(() => resolve());
    });
  });
}

function sessionMetaToSelectionOption(meta: SessionMeta): Record<string, unknown> {
  return {
    id: meta.id,
    cwd: meta.cwd,
    started_at: meta.startedAt,
    last_activity: meta.lastActivity,
    event_count: meta.eventCount,
    first_prompt: meta.firstPrompt,
    provider: meta.provider,
    model: meta.model,
  };
}

function isSelectableSession(meta: SessionMeta): boolean {
  return meta.eventCount > 0 && Boolean(meta.firstPrompt?.trim());
}

function hasBearer(header: string | string[] | undefined, token: string): boolean {
  return header === `Bearer ${token}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
  return raw.trim() ? JSON.parse(raw) : {};
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}
