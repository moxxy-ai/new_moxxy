import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { persistCodexTokens } from '@moxxy/plugin-provider-openai-codex';
import {
  createStaticKeySource,
  deriveKey,
  generateSalt,
  VaultStore,
} from '@moxxy/plugin-vault';
import {
  buildCodexTranscribeUrl,
  buildOpenaiCodexSttPlugin,
  CodexOAuthTranscriber,
  MOXXY_PCM16_24KHZ_MIME,
  pcm16MonoToWav,
} from './index.js';

interface CapturedRequest {
  readonly req: IncomingMessage;
  readonly body: Buffer;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeVault(): Promise<VaultStore> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moxxy-codex-stt-'));
  tempDirs.push(dir);
  return new VaultStore({
    filePath: path.join(dir, 'vault.json'),
    keySource: createStaticKeySource(deriveKey('test-passphrase', generateSalt())),
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

async function startServer(
  handler: (captured: CapturedRequest, res: ServerResponse) => void | Promise<void>,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    await handler({ req, body: await readBody(req) }, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('CodexOAuthTranscriber', () => {
  it('posts wav multipart audio to the Codex transcribe endpoint with OAuth headers', async () => {
    const vault = await makeVault();
    await persistCodexTokens(vault, {
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'acct_123',
    });

    let captured: CapturedRequest | null = null;
    const server = await startServer((request, res) => {
      captured = request;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'hello from codex' }));
    });

    try {
      const plugin = buildOpenaiCodexSttPlugin({
        vault,
        baseUrl: server.baseUrl,
        sessionIdProvider: () => 'stt-session-id',
      });
      const def = plugin.transcribers?.[0];
      expect(plugin.requirements).toEqual([
        {
          kind: 'plugin',
          name: '@moxxy/plugin-provider-openai-codex',
          state: 'registered',
          hint: 'Enable @moxxy/plugin-provider-openai-codex.',
        },
      ]);
      expect(def?.name).toBe('openai-codex-transcribe');
      expect(def?.requirements).toEqual([
        {
          kind: 'provider',
          name: 'openai-codex',
          state: 'active',
          hint: 'Switch provider to openai-codex.',
        },
        {
          kind: 'runtime',
          name: 'auth:provider:openai-codex',
          state: 'ready',
          hint: 'Run `moxxy login openai-codex`.',
        },
      ]);

      const transcriber = def!.createClient({});
      const result = await transcriber.transcribe(new Uint8Array([1, 2, 3, 4]), {
        mimeType: 'audio/wav',
      });

      expect(result.text).toBe('hello from codex');
      expect(captured?.req.method).toBe('POST');
      expect(captured?.req.url).toBe('/transcribe');
      expect(captured?.req.headers.authorization).toBe('Bearer access-token');
      expect(captured?.req.headers['chatgpt-account-id']).toBe('acct_123');
      expect(captured?.req.headers.session_id).toBe('stt-session-id');
      expect(captured?.req.headers.originator).toBe('Codex Desktop');
      expect(captured?.req.headers['user-agent']).toMatch(/^Mozilla\/5\.0/);
      expect(captured?.req.headers['content-type']).toContain('multipart/form-data; boundary=');
      expect(captured?.body.toString('latin1')).toContain('filename="moxxy.wav"');
      expect(captured?.body.toString('latin1')).toContain('Content-Type: audio/wav');
    } finally {
      await server.close();
    }
  });

  it('converts local pcm16/24k microphone bytes to wav before upload', async () => {
    const vault = await makeVault();
    await persistCodexTokens(vault, {
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });

    let body = Buffer.alloc(0);
    const server = await startServer((request, res) => {
      body = request.body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'pcm converted' }));
    });

    try {
      const transcriber = new CodexOAuthTranscriber({ vault, baseUrl: server.baseUrl });
      await transcriber.transcribe(new Uint8Array([1, 0, 2, 0]), {
        mimeType: MOXXY_PCM16_24KHZ_MIME,
      });

      expect(body.includes(Buffer.from('RIFF', 'ascii'))).toBe(true);
      expect(body.includes(Buffer.from('WAVE', 'ascii'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('fails with the login hint when OAuth credentials are missing', async () => {
    const vault = await makeVault();
    const transcriber = new CodexOAuthTranscriber({ vault, baseUrl: 'http://127.0.0.1:9' });

    await expect(transcriber.transcribe(new Uint8Array([1]), { mimeType: 'audio/wav' }))
      .rejects
      .toThrow(/moxxy login openai-codex/);
  });

  it('classifies 403 transcription responses as authorization denials', async () => {
    const vault = await makeVault();
    await persistCodexTokens(vault, {
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });

    const server = await startServer((_request, res) => {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><head><style>body{display:flex}</style></head></html>');
    });

    try {
      const transcriber = new CodexOAuthTranscriber({ vault, baseUrl: server.baseUrl });
      await expect(transcriber.transcribe(new Uint8Array([1]), { mimeType: 'audio/wav' }))
        .rejects
        .toMatchObject({
          code: 'AUTH_DENIED',
          message: expect.not.stringContaining('<html>'),
        });
    } finally {
      await server.close();
    }
  });

  it('rejects non-2xx and empty transcript responses', async () => {
    const vault = await makeVault();
    await persistCodexTokens(vault, {
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });

    const badServer = await startServer((_request, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    });
    try {
      const transcriber = new CodexOAuthTranscriber({ vault, baseUrl: badServer.baseUrl });
      await expect(transcriber.transcribe(new Uint8Array([1]), { mimeType: 'audio/wav' }))
        .rejects
        .toThrow(/500/);
    } finally {
      await badServer.close();
    }

    const emptyServer = await startServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '   ' }));
    });
    try {
      const transcriber = new CodexOAuthTranscriber({ vault, baseUrl: emptyServer.baseUrl });
      await expect(transcriber.transcribe(new Uint8Array([1]), { mimeType: 'audio/wav' }))
        .rejects
        .toThrow(/empty transcript/);
    } finally {
      await emptyServer.close();
    }
  });
});

describe('Codex transcribe helpers', () => {
  it('builds the ChatGPT and local transcribe URLs', () => {
    expect(buildCodexTranscribeUrl()).toBe('https://chatgpt.com/backend-api/transcribe');
    expect(buildCodexTranscribeUrl('https://chatgpt.com')).toBe('https://chatgpt.com/backend-api/transcribe');
    expect(buildCodexTranscribeUrl('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567/transcribe');
    expect(buildCodexTranscribeUrl('http://127.0.0.1:4567/backend-api')).toBe(
      'http://127.0.0.1:4567/backend-api/transcribe',
    );
  });

  it('wraps pcm16 mono 24khz bytes in a valid wav header', () => {
    const wav = pcm16MonoToWav(new Uint8Array([1, 0, 2, 0]), 24_000);
    const buf = Buffer.from(wav);

    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.readUInt32LE(24)).toBe(24_000);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.readUInt32LE(40)).toBe(4);
    expect(buf.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });
});
