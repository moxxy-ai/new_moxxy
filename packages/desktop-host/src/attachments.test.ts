import { describe, it, expect, afterEach } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { persistImageBlob } from './attachments';

/** Temp files persistImageBlob writes; cleaned up after each test. */
const written: string[] = [];

afterEach(async () => {
  await Promise.all(written.map((p) => unlink(p).catch(() => {})));
  written.length = 0;
});

const b64 = (bytes: Buffer): string => bytes.toString('base64');

describe('persistImageBlob', () => {
  it('writes the bytes to a temp file and returns a path + name', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const att = await persistImageBlob(b64(bytes), 'image/png');
    written.push(att.path);

    expect(path.extname(att.path)).toBe('.png');
    expect(att.name).toBe('pasted-image.png');
    const onDisk = await readFile(att.path);
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('keeps the source filename when one is given', async () => {
    const att = await persistImageBlob(b64(Buffer.from([1, 2, 3])), 'image/jpeg', 'shot.jpg');
    written.push(att.path);
    expect(att.name).toBe('shot.jpg');
    // Extension on disk follows the media type, not the display name.
    expect(path.extname(att.path)).toBe('.jpg');
  });

  it('gives each blob a unique path so repeated pastes never collide', async () => {
    const a = await persistImageBlob(b64(Buffer.from([1])), 'image/png');
    const b = await persistImageBlob(b64(Buffer.from([1])), 'image/png');
    written.push(a.path, b.path);
    expect(a.path).not.toBe(b.path);
  });

  it('rejects non-image media types', async () => {
    await expect(
      persistImageBlob(b64(Buffer.from('hello')), 'text/plain'),
    ).rejects.toThrow(/only images/i);
  });

  it('rejects an empty blob', async () => {
    await expect(persistImageBlob('', 'image/png')).rejects.toThrow(/empty/i);
  });

  it('rejects blobs over the size cap', async () => {
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1);
    await expect(persistImageBlob(b64(tooBig), 'image/png')).rejects.toThrow(/too large/i);
  });
});
