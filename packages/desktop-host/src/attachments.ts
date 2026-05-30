/**
 * Turn picked file paths into real {@link UserPromptAttachment}s.
 *
 * The renderer can only hand us a path (no fs access), but the model needs the
 * actual payload: base64 bytes for an image, inline text for a text/code file.
 * Earlier the desktop shipped the *path string* as the attachment `content`,
 * so the model saw `[file foo.png]\n/Users/…/foo.png` and the attachment was
 * effectively ignored. This reads the file in the main process and builds the
 * correct attachment — images as `image`, everything text-like as `file` —
 * skipping anything binary, oversized, or unreadable.
 *
 * It also owns {@link persistImageBlob}: pasted/dropped images arrive as raw
 * bytes (no path), so we stash them in a temp file and hand back a path the
 * same {@link buildAttachments} pipeline can read on the next turn.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UserPromptAttachment } from '@moxxy/sdk';

/** Image extensions we forward as inline base64 with a real mediaType. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Caps so a renderer-chosen file can't OOM the main process / blow the prompt. */
const MAX_TEXT_BYTES = 512 * 1024; // 512 KB of text
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB image

/** True for the image extensions we accept. */
export function isImagePath(p: string): boolean {
  return path.extname(p).toLowerCase() in IMAGE_MEDIA_TYPES;
}

export async function buildAttachments(
  files: ReadonlyArray<{ path: string; name: string }>,
): Promise<UserPromptAttachment[]> {
  const out: UserPromptAttachment[] = [];
  for (const f of files) {
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(f.path).toLowerCase()];
    try {
      const buf = await readFile(f.path);
      if (mediaType) {
        if (buf.byteLength > MAX_IMAGE_BYTES) continue;
        out.push({ kind: 'image', content: buf.toString('base64'), mediaType, name: f.name });
      } else {
        // Text-like only: skip oversized and binary (NUL byte) files so we
        // never inline garbage the model can't use.
        if (buf.byteLength > MAX_TEXT_BYTES) continue;
        if (buf.includes(0)) continue;
        out.push({ kind: 'file', content: buf.toString('utf8'), name: f.name });
      }
    } catch {
      // Unreadable (gone / permission) → drop it rather than fail the turn.
    }
  }
  return out;
}

/** MIME type → file extension for the image blobs we accept on paste. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/** Where pasted/dropped image blobs land before a turn reads them. */
const ATTACHMENT_TMP_DIR = path.join(os.tmpdir(), 'moxxy-attachments');
/** Sweep temp attachments older than this so pastes don't accumulate. */
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a base64 image blob the renderer pasted or dropped (it can't touch
 * the filesystem) to a temp file, returning a `{ path, name }` the existing
 * attachment pipeline ships unchanged. Throws if the blob isn't an accepted
 * image type or exceeds {@link MAX_IMAGE_BYTES} — the renderer surfaces the
 * message as a transient notice.
 */
export async function persistImageBlob(
  dataBase64: string,
  mediaType: string,
  name?: string,
): Promise<{ path: string; name: string }> {
  const ext = IMAGE_EXTENSIONS[mediaType.toLowerCase()];
  if (!ext) throw new Error(`Can't attach ${mediaType || 'this'} — only images can be pasted.`);
  const buf = Buffer.from(dataBase64, 'base64');
  if (buf.byteLength === 0) throw new Error('Pasted image was empty.');
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is too large to attach (max ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB).`,
    );
  }
  await mkdir(ATTACHMENT_TMP_DIR, { recursive: true });
  void pruneOldAttachments();
  const filePath = path.join(ATTACHMENT_TMP_DIR, `${randomUUID()}.${ext}`);
  await writeFile(filePath, buf);
  const display = name && name.trim().length > 0 ? name : `pasted-image.${ext}`;
  return { path: filePath, name: display };
}

/** Best-effort sweep of stale temp attachments. Never throws — a failed
 *  prune just means the next save tries again. */
async function pruneOldAttachments(): Promise<void> {
  try {
    const now = Date.now();
    const entries = await readdir(ATTACHMENT_TMP_DIR);
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(ATTACHMENT_TMP_DIR, entry);
        try {
          const info = await stat(full);
          if (now - info.mtimeMs > ATTACHMENT_TTL_MS) await unlink(full);
        } catch {
          /* already gone / racing another sweep */
        }
      }),
    );
  } catch {
    /* dir missing or unreadable — nothing to prune */
  }
}
