import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest is configured with `globals: false`, so @testing-library/react
// does NOT auto-register its `afterEach(cleanup)` hook. We do it ourselves
// here so DOM state never leaks between tests.
afterEach(() => {
  cleanup();
});

// jsdom doesn't ship MediaRecorder; install a no-op shim so the voice
// hook's import-time guards don't trip. Per-test fixtures replace it.
if (typeof globalThis.MediaRecorder === 'undefined') {
  class MediaRecorderShim {
    public state: 'inactive' | 'recording' | 'paused' = 'inactive';
    public ondataavailable: ((ev: { data: Blob }) => void) | null = null;
    public onstop: (() => void) | null = null;
    public start(): void {
      this.state = 'recording';
    }
    public stop(): void {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([], { type: 'audio/webm' }) });
      this.onstop?.();
    }
    public static isTypeSupported(): boolean {
      return true;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MediaRecorder = MediaRecorderShim;
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices === undefined) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () =>
        Promise.reject(new Error('test setup: getUserMedia not stubbed')),
    },
  });
}

// jsdom's Blob misses `arrayBuffer()` in some versions; polyfill via
// FileReader so the voice recorder's encoder path works in tests.
if (
  typeof Blob !== 'undefined' &&
  typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== 'function'
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Blob.prototype as any).arrayBuffer = function arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this as unknown as Blob);
    });
  };
}
