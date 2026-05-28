import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVoiceRecorder } from './voice';
import { mockTauri } from '@/__mocks__/tauri';

vi.mock('@/lib/tauri', () => import('@/__mocks__/tauri'));

/**
 * Fixture MediaRecorder. Tests instruct it via `next*` setters to
 * control what `stop()` emits.
 */
class FakeMediaRecorder {
  public state: 'inactive' | 'recording' | 'paused' = 'inactive';
  public ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;
  public readonly mimeType: string;
  public static blobPayload: Blob = new Blob(['hi'], { type: 'audio/webm' });

  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: FakeMediaRecorder.blobPayload });
    this.onstop?.();
  }
  static isTypeSupported(t: string): boolean {
    return t.startsWith('audio/webm');
  }
}

function installFakeMediaRecorder(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MediaRecorder = FakeMediaRecorder;
}

function stubGetUserMedia(succeed: boolean, reason = 'denied'): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () =>
        succeed
          ? Promise.resolve({
              getTracks: () => [{ stop: () => {} }],
            } as unknown as MediaStream)
          : Promise.reject(new Error(reason)),
    },
  });
}

describe('useVoiceRecorder', () => {
  beforeEach(() => {
    mockTauri.reset();
    installFakeMediaRecorder();
    FakeMediaRecorder.blobPayload = new Blob(['hi'], { type: 'audio/webm' });
  });
  afterEach(() => {
    // Restore the original stubs.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
  });

  it('starts as idle with no error', () => {
    stubGetUserMedia(true);
    const { result } = renderHook(() => useVoiceRecorder());
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('records and transcribes the captured blob', async () => {
    stubGetUserMedia(true);
    mockTauri.respond('transcribe', (args) => {
      expect(args).toMatchObject({
        mimeType: expect.stringContaining('audio/'),
        audioB64: expect.any(String),
      });
      return { text: 'transcribed text' };
    });

    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe('recording');

    let transcript: string | null = null;
    await act(async () => {
      transcript = await result.current.stop();
    });
    expect(transcript).toBe('transcribed text');
    await waitFor(() => expect(result.current.state).toBe('idle'));
  });

  it('captures the error if the mic is denied', async () => {
    stubGetUserMedia(false, 'NotAllowedError');
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toContain('NotAllowedError');
  });

  it('stop() while idle returns null without invoking', async () => {
    stubGetUserMedia(true);
    const { result } = renderHook(() => useVoiceRecorder());
    const transcript = await result.current.stop();
    expect(transcript).toBeNull();
    expect(mockTauri.calls.find((c) => c.cmd === 'transcribe')).toBeUndefined();
  });

  it('falls back to idle and records the error when transcribe fails', async () => {
    stubGetUserMedia(true);
    mockTauri.respond('transcribe', () => {
      throw new Error('runner offline');
    });
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    let transcript: string | null = null;
    await act(async () => {
      transcript = await result.current.stop();
    });
    expect(transcript).toBeNull();
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('runner offline');
  });

  it('cancel() releases the recorder and returns to idle', async () => {
    stubGetUserMedia(true);
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.cancel());
    expect(result.current.state).toBe('idle');
  });

  it('ignores a result without a text field', async () => {
    stubGetUserMedia(true);
    mockTauri.respond('transcribe', () => ({ language: 'en' }));
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    let transcript: string | null = null;
    await act(async () => {
      transcript = await result.current.stop();
    });
    expect(transcript).toBeNull();
  });
});
