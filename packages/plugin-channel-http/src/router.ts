import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientSession as Session } from '@moxxy/sdk';
import type { MoxxyEvent } from '@moxxy/sdk';

export const turnRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export type TurnRequest = z.infer<typeof turnRequestSchema>;

export interface RouterContext {
  readonly session: Session;
  readonly authToken: string | null;
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouterContext) => Promise<void>;

/** Match HTTP request to a handler. Returns null if no route matches. */
export function routeRequest(req: IncomingMessage): RouteHandler | null {
  const rawUrl = req.url ?? '/';
  // Strip the query string before matching — `/v1/turn/audio?model=...`
  // is the same route as `/v1/turn/audio`. The handler reads query
  // params off req.url itself.
  const pathname = rawUrl.split('?')[0] ?? rawUrl;
  if (req.method === 'GET' && pathname === '/v1/health') return handleHealth;
  if (req.method === 'POST' && pathname === '/v1/turn') return handleTurn;
  if (req.method === 'POST' && pathname === '/v1/turn/stream') return handleTurnStream;
  if (req.method === 'POST' && pathname === '/v1/turn/audio') return handleTurnAudio;
  return null;
}

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}

function checkAuth(req: IncomingMessage, expected: string | null): boolean {
  if (!expected) return true;
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${expected}`);
  // Constant-time compare so the token isn't recoverable byte-by-byte via
  // response-timing. (The length check short-circuits unequal lengths — that
  // only leaks length, which is fine for a fixed-format bearer token.)
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<string> {
  return (await readBodyBytes(req, max)).toString('utf8');
}

/** Audio uploads need a much larger cap than JSON; 10 MB covers a few
 *  minutes of Opus voice (Telegram caps voice notes at 50 MB, but
 *  realistic notes are well under that). */
const DEFAULT_AUDIO_MAX = 10 * 1024 * 1024;

async function readBodyBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: TurnRequest;
  try {
    const raw = await readBody(req);
    body = turnRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const events: MoxxyEvent[] = [];
  try {
    for await (const event of ctx.session.runTurn(body.prompt, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
    })) {
      events.push(event);
    }
  } catch (err) {
    reply(res, 500, { error: 'turn_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const finalAssistant = events.findLast?.((e) => e.type === 'assistant_message');
  const assistant =
    finalAssistant && finalAssistant.type === 'assistant_message' ? finalAssistant.content : '';
  reply(res, 200, { events, assistant });
}

/**
 * Audio-in turn. Designed for iOS Shortcuts and curl: the client POSTs
 * raw audio bytes with `Content-Type: audio/<format>`. Optional query
 * params (`model`, `language`, `systemPrompt`) tune the run.
 *
 * The session must have an active Transcriber registered (e.g. via
 * `@moxxy/plugin-stt-whisper`); without one the endpoint returns 503
 * rather than transparently dropping the audio.
 */
export async function handleTurnAudio(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  const transcriber = ctx.session.transcribers.tryGetActive();
  if (!transcriber) {
    reply(res, 503, {
      error: 'no_transcriber',
      message:
        'No active Transcriber on this session. Install @moxxy/plugin-stt-whisper (or another transcriber plugin) and activate it before POSTing audio.',
    });
    return;
  }

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('audio/')) {
    reply(res, 415, {
      error: 'unsupported_media_type',
      message: "Expected Content-Type: audio/* (e.g. audio/ogg, audio/m4a, audio/mpeg).",
    });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readBodyBytes(req, DEFAULT_AUDIO_MAX);
  } catch (err) {
    reply(res, 413, { error: 'payload_too_large', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (bytes.length === 0) {
    reply(res, 400, { error: 'empty_body', message: 'audio body is empty' });
    return;
  }

  // Pull tuning params off the query string — keeping them out of the
  // body lets the payload remain raw audio (cleanest curl / Shortcut flow).
  const url = new URL(req.url ?? '/', 'http://localhost');
  const model = url.searchParams.get('model') ?? undefined;
  const language = url.searchParams.get('language') ?? undefined;
  const promptHint = url.searchParams.get('prompt') ?? undefined;
  const systemPrompt = url.searchParams.get('systemPrompt') ?? undefined;

  let transcript: string;
  try {
    const result = await transcriber.transcribe(new Uint8Array(bytes), {
      mimeType: contentType,
      ...(language ? { language } : {}),
      ...(promptHint ? { prompt: promptHint } : {}),
    });
    transcript = result.text.trim();
  } catch (err) {
    ctx.logger?.warn('http audio transcription failed', { err: err instanceof Error ? err.message : String(err) });
    reply(res, 502, { error: 'transcription_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!transcript) {
    reply(res, 422, { error: 'empty_transcript', message: 'transcriber returned empty text' });
    return;
  }

  const events: MoxxyEvent[] = [];
  try {
    for await (const event of ctx.session.runTurn(transcript, {
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    })) {
      events.push(event);
    }
  } catch (err) {
    reply(res, 500, { error: 'turn_failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const finalAssistant = events.findLast?.((e) => e.type === 'assistant_message');
  const assistant =
    finalAssistant && finalAssistant.type === 'assistant_message' ? finalAssistant.content : '';
  reply(res, 200, { transcript, events, assistant });
}

export async function handleTurnStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouterContext,
): Promise<void> {
  if (!checkAuth(req, ctx.authToken)) {
    reply(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: TurnRequest;
  try {
    const raw = await readBody(req);
    body = turnRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    reply(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Abort the turn when the client hangs up — without this the model keeps
  // generating (and billing) with nothing consuming the SSE stream.
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  res.on('close', onClose);

  const writeEvent = (event: MoxxyEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    for await (const event of ctx.session.runTurn(body.prompt, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
      signal: controller.signal,
    })) {
      writeEvent(event);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`);
  } finally {
    res.off('close', onClose);
    res.end();
  }
}
