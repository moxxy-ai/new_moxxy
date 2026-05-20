import type { Context } from 'grammy';
import type { Session } from '@moxxy/core';
import type { ChannelHandle } from '@moxxy/sdk';
import type { TelegramApprovalResolver } from '../approval.js';
import type { TelegramPermissionResolver } from '../permission.js';
import type { FramePump } from './frame-pump.js';
import type { PairingHandler } from './pairing-handler.js';
import type { AwaitingApprovalText } from './callback-handler.js';

export interface VoiceHandlerState {
  readonly session: Session | null;
  readonly model: string | undefined;
  readonly activeModelOverride: string | null;
  readonly yolo: boolean;
  readonly busy: boolean;
  readonly turnController: AbortController | null;
  readonly awaitingApprovalText: AwaitingApprovalText | null;
  readonly handle: ChannelHandle | null;
}

export interface VoiceHandlerDeps {
  readonly pairing: PairingHandler;
  readonly approvalResolver: TelegramApprovalResolver;
  readonly permissionResolver: TelegramPermissionResolver;
  readonly framePump: FramePump;
  /** Bot token, used to build the Telegram file-download URL. */
  readonly token: string;
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface VoiceHandlerCallbacks {
  readonly runUserTurn: (ctx: Context, chatId: number, text: string) => Promise<void>;
  /** Override the network fetch for tests. Defaults to global `fetch`. */
  readonly fetchAudio?: (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
}

/**
 * Handle inbound voice notes and uploaded audio files. Authorization
 * gate matches the text path. If no Transcriber is registered on the
 * session, reply with a one-time guidance message instead of silently
 * swallowing the audio. Otherwise: download via Bot-API file URL,
 * transcribe through the active Transcriber, echo a short "heard:"
 * confirmation, then run a normal user turn with the transcript.
 */
export async function handleVoiceMessage(
  ctx: Context,
  state: VoiceHandlerState,
  deps: VoiceHandlerDeps,
  cb: VoiceHandlerCallbacks,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Pull whichever audio variant Telegram delivered. `voice` is a press-
  // and-hold voice note; `audio` is an uploaded audio file. Both expose
  // a `file_id` and (for voice) a mime_type — we trust voice's
  // `audio/ogg` default when missing.
  const voice = ctx.message?.voice;
  const audio = ctx.message?.audio;
  const media = voice ?? audio;
  if (!media) return;

  if (!deps.pairing.isAuthorized(chatId)) {
    await ctx.reply(
      'This bot is paired with a different chat (or not paired yet). Run `moxxy telegram pair` to (re-)pair.',
    );
    return;
  }

  if (state.busy) {
    await ctx.reply('I am still working on the previous prompt. Send /cancel to abort it.');
    return;
  }

  if (!state.session) {
    await ctx.reply('Session is not ready yet.');
    return;
  }

  const transcriber = state.session.transcribers.tryGetActive();
  if (!transcriber) {
    await ctx.reply(
      "Heard a voice note, but no speech-to-text backend is configured. Install @moxxy/plugin-stt-whisper and run `moxxy login openai` (or set OPENAI_API_KEY) to enable voice input.",
    );
    return;
  }

  const fileInfo = await ctx.api.getFile(media.file_id);
  if (!fileInfo.file_path) {
    await ctx.reply('Telegram did not return a downloadable file path for that voice note.');
    return;
  }
  const url = `https://api.telegram.org/file/bot${deps.token}/${fileInfo.file_path}`;
  const fetcher = cb.fetchAudio ?? ((u: string) => fetch(u));
  const response = await fetcher(url);
  if (!response.ok) {
    deps.logger?.warn('telegram voice download failed', { status: 'ok=false' });
    await ctx.reply('Failed to download the voice note from Telegram.');
    return;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  // Voice notes are OGG/Opus by default; uploaded audio carries its own mime.
  const mimeType = media.mime_type ?? (voice ? 'audio/ogg' : 'audio/mpeg');
  let transcript: string;
  try {
    const result = await transcriber.transcribe(bytes, { mimeType });
    transcript = result.text.trim();
  } catch (err) {
    deps.logger?.warn('telegram voice transcription failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(
      `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!transcript) {
    await ctx.reply('Could not transcribe the voice note (got empty text).');
    return;
  }

  // Echo what we heard so the user can spot misrecognitions before the
  // agent acts on it. Italics keep it visually distinct from a normal
  // reply.
  await ctx.reply(`_heard:_ ${transcript}`, { parse_mode: 'Markdown' });

  await cb.runUserTurn(ctx, chatId, transcript);
}
