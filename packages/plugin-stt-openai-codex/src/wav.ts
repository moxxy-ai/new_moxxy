export function pcm16MonoToWav(pcm: Uint8Array | ArrayBuffer, sampleRate = 24_000): Uint8Array {
  const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const headerBytes = 44;
  const wav = new Uint8Array(headerBytes + data.byteLength);
  const view = new DataView(wav.buffer);

  writeAscii(wav, 0, 'RIFF');
  view.setUint32(4, 36 + data.byteLength, true);
  writeAscii(wav, 8, 'WAVE');
  writeAscii(wav, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, 'data');
  view.setUint32(40, data.byteLength, true);
  wav.set(data, headerBytes);

  return wav;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    target[offset + i] = value.charCodeAt(i);
  }
}
