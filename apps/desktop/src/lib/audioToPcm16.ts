/**
 * Decode a recorded audio Blob (webm/opus, mp4, etc. — whatever
 * MediaRecorder produced) and re-encode it as raw PCM16 LE mono @
 * 24 kHz. This is the format the moxxy Codex transcriber expects via
 * the `audio/x-moxxy-pcm16-24khz` MIME flag — same as the TUI's
 * voice path, which converts via ffmpeg (we can't ship ffmpeg in
 * the renderer, so AudioContext does the job).
 *
 * Output is a Uint8Array of `samples.byteLength === pcm16.length * 2`
 * little-endian signed 16-bit samples. The Codex transcriber wraps
 * them in a WAV header before upload.
 */

const TARGET_SAMPLE_RATE = 24_000;

/** The MIME tag the moxxy whisper helpers use to flag "raw PCM16 mono
 *  24 kHz". The Codex transcriber sees this and wraps the bytes in a
 *  WAV header for upload. */
export const MOXXY_PCM16_24KHZ_MIME = 'audio/x-moxxy-pcm16-24khz';

export async function audioToPcm16(blob: Blob): Promise<Uint8Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext is not available');

  // OfflineAudioContext lets us decode at any source rate first, then
  // OFFLINE-render to a fixed sample-rate buffer. Cheaper + no
  // realtime playback side effects. We pass the source rate of the
  // input then resample in a second offline pass.
  const decodeCtx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void decodeCtx.close();
  }

  // Resample to 24 kHz mono via OfflineAudioContext.
  const targetLength = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const mono = rendered.getChannelData(0);

  // Float32 (-1..1) → Int16 LE. Clamp + scale.
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const sample = Math.max(-1, Math.min(1, mono[i] ?? 0));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** Base64-encode a Uint8Array without spilling the entire string into
 *  a single `String.fromCharCode(...)` call (which blows the V8 stack
 *  past ~120 KB). Chunks the conversion so multi-second clips work. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}
