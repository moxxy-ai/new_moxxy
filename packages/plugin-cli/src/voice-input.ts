import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RequirementCheck, RequirementIssue } from '@moxxy/sdk';

export const VOICE_CAPTURE_RUNTIME = 'voice:capture:ffmpeg';

export interface ActiveVoiceRecording {
  stop(): Promise<Buffer>;
}

export interface FfmpegArgsOptions {
  readonly platform?: NodeJS.Platform;
  readonly audioDevice?: string;
}

export interface StartVoiceRecordingOptions {
  readonly command?: string;
  readonly platform?: NodeJS.Platform;
  readonly audioDevice?: string;
  readonly stopTimeoutMs?: number;
  readonly spawnImpl?: typeof spawn;
}

export interface VoiceCaptureAvailabilityOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly spawnImpl?: typeof spawn;
}

export function buildFfmpegArgs(options: NodeJS.Platform | FfmpegArgsOptions = process.platform): string[] {
  const platform = typeof options === 'string' ? options : options.platform ?? process.platform;
  const audioDevice = typeof options === 'string' ? undefined : options.audioDevice;
  const input = platformInput(platform, audioDevice);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    input.format,
    '-i',
    input.device,
    '-ac',
    '1',
    '-ar',
    '24000',
    '-f',
    's16le',
    '-',
  ];
}

export async function startVoiceRecording(
  opts: StartVoiceRecordingOptions = {},
): Promise<ActiveVoiceRecording> {
  const command = opts.command ?? 'ffmpeg';
  const platform = opts.platform ?? process.platform;
  const audioDevice = opts.audioDevice ?? process.env.MOXXY_VOICE_AUDIO_DEVICE;
  const args = buildFfmpegArgs({ platform, ...(audioDevice ? { audioDevice } : {}) });
  const child = (opts.spawnImpl ?? spawn)(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const chunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let closeState: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;

  child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
    while (Buffer.concat(stderrChunks).byteLength > 16_384) stderrChunks.shift();
  });

  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      closeState = { code, signal };
      resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => reject(toSpawnError(command, err)));
  });

  let stopPromise: Promise<Buffer> | null = null;
  return {
    stop() {
      stopPromise ??= stopProcess({
        child,
        closed,
        chunks,
        stderrChunks,
        closeState: () => closeState,
        stopTimeoutMs: opts.stopTimeoutMs ?? 1_500,
      });
      return stopPromise;
    },
  };
}

export async function checkVoiceCaptureAvailable(
  opts: VoiceCaptureAvailabilityOptions = {},
): Promise<RequirementCheck> {
  const command = opts.command ?? 'ffmpeg';
  const child = (opts.spawnImpl ?? spawn)(command, ['-version'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return new Promise<RequirementCheck>((resolve) => {
    let settled = false;
    const done = (check: RequirementCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(check);
    };

    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      done(unavailableVoiceCaptureCheck());
    }, opts.timeoutMs ?? 1_500);

    child.once('error', () => done(unavailableVoiceCaptureCheck()));
    child.once('close', (code) => {
      done(code === 0 ? { ready: true, issues: [] } : unavailableVoiceCaptureCheck());
    });
  });
}

export function unavailableVoiceCaptureCheck(): RequirementCheck {
  return {
    ready: false,
    issues: [
      {
        requirement: {
          kind: 'runtime',
          name: VOICE_CAPTURE_RUNTIME,
          state: 'ready',
          hint: 'Install ffmpeg and ensure it is available on PATH.',
        },
        code: 'not_ready',
        message: 'ffmpeg is required for voice input',
        hint: 'Install ffmpeg and ensure it is available on PATH.',
      } satisfies RequirementIssue,
    ],
  };
}

function platformInput(
  platform: NodeJS.Platform,
  audioDevice: string | undefined,
): { readonly format: string; readonly device: string } {
  if (platform === 'darwin') return { format: 'avfoundation', device: formatDarwinAudioDevice(audioDevice) };
  if (platform === 'win32') return { format: 'dshow', device: formatWindowsAudioDevice(audioDevice) };
  if (platform === 'linux') return { format: 'pulse', device: audioDevice ?? 'default' };
  throw new Error(`voice input is not supported on ${platform}`);
}

function formatDarwinAudioDevice(audioDevice: string | undefined): string {
  if (!audioDevice) return ':default';
  return audioDevice.startsWith(':') ? audioDevice : `:${audioDevice}`;
}

function formatWindowsAudioDevice(audioDevice: string | undefined): string {
  if (!audioDevice) return 'audio=default';
  return audioDevice.startsWith('audio=') ? audioDevice : `audio=${audioDevice}`;
}

async function stopProcess(args: {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  readonly chunks: Buffer[];
  readonly stderrChunks: Buffer[];
  readonly closeState: () => { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  readonly stopTimeoutMs: number;
}): Promise<Buffer> {
  const { child, closed, chunks, stderrChunks, stopTimeoutMs } = args;
  if (!child.killed && child.stdin.writable) {
    child.stdin.write('q');
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, stopTimeoutMs);

  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }

  const pcm = Buffer.concat(chunks);
  if (pcm.byteLength === 0) {
    const details = Buffer.concat(stderrChunks).toString('utf8').trim();
    const suffix = details ? ` ${details}` : '';
    const state = args.closeState();
    throw new Error(
      `ffmpeg did not capture any audio${state ? ` (exit ${state.code ?? state.signal ?? 'unknown'})` : ''}.${suffix}`,
    );
  }
  return pcm;
}

function toSpawnError(command: string, err: unknown): Error {
  if (isNodeError(err) && err.code === 'ENOENT') {
    return new Error(`ffmpeg was not found at "${command}". Install ffmpeg and ensure it is available on PATH.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
