import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { Session } from '@moxxy/core';
import { defineTranscriber } from '@moxxy/sdk';
import { handleVoiceMessage } from './voice-handler.js';

const TOKEN = '1234567890:test-token';

const makeSession = (): Session => new Session({ cwd: '/tmp', silent: true });

const fakeCtx = (overrides: Partial<{ chatId: number; voice: unknown; audio: unknown; filePath: string | null }> = {}) => {
  const replies: string[] = [];
  const reply = vi.fn(async (text: string) => {
    replies.push(text);
  });
  const getFile = vi.fn(async () => ({
    file_id: 'f',
    file_unique_id: 'u',
    file_path: overrides.filePath === undefined ? 'voice/file.ogg' : overrides.filePath,
  }));
  return {
    ctx: {
      chat: { id: overrides.chatId ?? 99 },
      message: {
        voice: overrides.voice,
        audio: overrides.audio,
      },
      reply,
      api: { getFile },
    } as unknown as Context,
    replies,
    reply,
    getFile,
  };
};

const okFetch = (bytes: Uint8Array) =>
  vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(0) }));

describe('handleVoiceMessage', () => {
  const baseDeps = (token = TOKEN) => ({
    pairing: { isAuthorized: () => true } as never,
    approvalResolver: {} as never,
    permissionResolver: {} as never,
    framePump: {} as never,
    token,
  });

  it('rejects unauthorized chats', async () => {
    const { ctx, replies } = fakeCtx({ voice: { file_id: 'f' } });
    const runUserTurn = vi.fn();
    await handleVoiceMessage(
      ctx,
      {
        session: makeSession(),
        model: undefined,
        activeModelOverride: null,
        yolo: false,
        busy: false,
        turnController: null,
        awaitingApprovalText: null,
        handle: null,
      },
      { ...baseDeps(), pairing: { isAuthorized: () => false } as never },
      { runUserTurn, fetchAudio: okFetch(new Uint8Array([1])) },
    );
    expect(replies[0]).toMatch(/paired with a different chat/);
    expect(runUserTurn).not.toHaveBeenCalled();
  });

  it('warns when no transcriber is registered on the session', async () => {
    const { ctx, replies } = fakeCtx({ voice: { file_id: 'f' } });
    const runUserTurn = vi.fn();
    const session = makeSession();
    await handleVoiceMessage(
      ctx,
      {
        session,
        model: undefined,
        activeModelOverride: null,
        yolo: false,
        busy: false,
        turnController: null,
        awaitingApprovalText: null,
        handle: null,
      },
      baseDeps(),
      { runUserTurn, fetchAudio: okFetch(new Uint8Array([1])) },
    );
    expect(replies[0]).toMatch(/no speech-to-text backend/);
    expect(runUserTurn).not.toHaveBeenCalled();
  });

  it('transcribes and forwards the transcript to runUserTurn', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const session = makeSession();
    const transcribe = vi.fn(async () => ({ text: 'hello agent' }));
    session.transcribers.register(
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe }),
      }),
    );
    session.transcribers.setActive('t');

    const { ctx, replies, getFile } = fakeCtx({
      voice: { file_id: 'voice-1', mime_type: 'audio/ogg' },
    });
    const runUserTurn = vi.fn(async () => {});
    await handleVoiceMessage(
      ctx,
      {
        session,
        model: undefined,
        activeModelOverride: null,
        yolo: false,
        busy: false,
        turnController: null,
        awaitingApprovalText: null,
        handle: null,
      },
      baseDeps(),
      { runUserTurn, fetchAudio: okFetch(audio) },
    );
    expect(getFile).toHaveBeenCalledWith('voice-1');
    expect(transcribe).toHaveBeenCalled();
    const transcribeArgs = transcribe.mock.calls[0]!;
    expect((transcribeArgs[1] as { mimeType: string }).mimeType).toBe('audio/ogg');
    expect(replies.some((r) => /heard:/.test(r) && /hello agent/.test(r))).toBe(true);
    expect(runUserTurn).toHaveBeenCalledWith(ctx, 99, 'hello agent');
  });

  it('refuses to start a new turn while busy', async () => {
    const session = makeSession();
    session.transcribers.register(
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe: async () => ({ text: 'x' }) }),
      }),
    );
    session.transcribers.setActive('t');
    const { ctx, replies } = fakeCtx({ voice: { file_id: 'f' } });
    const runUserTurn = vi.fn();
    await handleVoiceMessage(
      ctx,
      {
        session,
        model: undefined,
        activeModelOverride: null,
        yolo: false,
        busy: true,
        turnController: null,
        awaitingApprovalText: null,
        handle: null,
      },
      baseDeps(),
      { runUserTurn, fetchAudio: okFetch(new Uint8Array([1])) },
    );
    expect(replies[0]).toMatch(/working on the previous prompt/);
    expect(runUserTurn).not.toHaveBeenCalled();
  });

  it('replies on empty transcript and skips the turn', async () => {
    const session = makeSession();
    session.transcribers.register(
      defineTranscriber({
        name: 't',
        createClient: () => ({ name: 't', transcribe: async () => ({ text: '   ' }) }),
      }),
    );
    session.transcribers.setActive('t');
    const { ctx, replies } = fakeCtx({ voice: { file_id: 'f' } });
    const runUserTurn = vi.fn();
    await handleVoiceMessage(
      ctx,
      {
        session,
        model: undefined,
        activeModelOverride: null,
        yolo: false,
        busy: false,
        turnController: null,
        awaitingApprovalText: null,
        handle: null,
      },
      baseDeps(),
      { runUserTurn, fetchAudio: okFetch(new Uint8Array([1])) },
    );
    expect(replies.some((r) => /empty text/.test(r))).toBe(true);
    expect(runUserTurn).not.toHaveBeenCalled();
  });

  it('handles uploaded audio (message:audio) with its own mime_type', async () => {
    const session = makeSession();
    const transcribe = vi.fn(async () => ({ text: 'recorded earlier' }));
    session.transcribers.register(
      defineTranscriber({ name: 't', createClient: () => ({ name: 't', transcribe }) }),
    );
    session.transcribers.setActive('t');
    const { ctx } = fakeCtx({
      audio: { file_id: 'a-1', mime_type: 'audio/mpeg' },
    });
    const runUserTurn = vi.fn(async () => {});
    await handleVoiceMessage(
      ctx,
      {
        session,
        model: undefined,
        activeModelOverride: null,
        yolo: false,
        busy: false,
        turnController: null,
        awaitingApprovalText: null,
        handle: null,
      },
      baseDeps(),
      { runUserTurn, fetchAudio: okFetch(new Uint8Array([9])) },
    );
    expect((transcribe.mock.calls[0]![1] as { mimeType: string }).mimeType).toBe('audio/mpeg');
    expect(runUserTurn).toHaveBeenCalledWith(ctx, 99, 'recorded earlier');
  });
});
