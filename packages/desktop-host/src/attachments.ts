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
 */

import { readFile } from 'node:fs/promises';
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
