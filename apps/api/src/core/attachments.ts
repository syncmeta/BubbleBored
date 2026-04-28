import { randomUUID } from 'crypto';
import {
  createAttachment,
  findAttachmentById,
  deleteOrphanAttachments,
  type AttachmentRow,
} from '../db/queries';
import { getBlob } from '../adapters/blob';

// Attachments live behind the BlobDriver — local fs in self-host mode, R2 in
// hosted mode. The DB still holds metadata + a stable opaque key (path-shaped
// "yyyy-mm/<uuid>.<ext>"); the driver decides where bytes physically live and
// how /uploads/<id> serves them.

// Supported image types. We deliberately do not accept SVG (XSS vector) or
// HEIC (browsers can't render it inline without decoding). Clients that send
// HEIC should transcode first.
export const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function isSupportedImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_TO_EXT, mime.toLowerCase());
}

function yearMonthBucket(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// The row the upload endpoint returns to the client, stripped of the on-disk
// path (clients refer to attachments by id, not filesystem location).
export interface UploadedAttachment {
  id: string;
  kind: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  url: string; // /uploads/<id> — stable, served by index.ts
}

/**
 * Persist an uploaded file to blob storage and create an orphan
 * (message_id=NULL) attachment row. The client later sends the returned id
 * in the WS chat payload to bind it to a message.
 *
 * Returns null on validation failure so the caller can pick a 4xx.
 */
export async function saveUpload(args: {
  bytes: Uint8Array;
  mime: string;
  conversationId?: string | null;
}): Promise<UploadedAttachment | { error: string }> {
  const { bytes, mime } = args;
  const normMime = mime.toLowerCase();

  if (!isSupportedImageMime(normMime)) {
    return { error: `unsupported mime: ${mime}` };
  }
  if (bytes.byteLength === 0) {
    return { error: 'empty file' };
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` };
  }

  const ext = IMAGE_MIME_TO_EXT[normMime];
  const id = randomUUID();
  const bucket = yearMonthBucket();
  const key = `${bucket}/${id}.${ext}`;

  await getBlob().put(key, bytes, normMime);

  createAttachment(
    id,
    args.conversationId ?? null,
    'image',
    normMime,
    key,
    bytes.byteLength,
    null, null, // width/height — not probed yet; cheap to add later with a decoder
  );

  return {
    id,
    kind: 'image',
    mime: normMime,
    size: bytes.byteLength,
    url: `/uploads/${id}`,
  };
}

/**
 * Read raw attachment bytes. Used by the vision prompt path which needs to
 * inline the image into the LLM payload. Prefer the serving response path
 * for HTTP responses so R2 can short-circuit with a redirect.
 */
export async function readAttachmentFile(row: AttachmentRow): Promise<Uint8Array | null> {
  return getBlob().getBytes(row.path);
}

/**
 * Build the response for `/uploads/<id>` after the caller has confirmed the
 * viewer is authorized. Returns null if the row or backing object is missing
 * — caller should map to 404.
 */
export async function getAttachmentServingResponse(id: string): Promise<{
  row: AttachmentRow;
  response: Response;
} | null> {
  const row = findAttachmentById(id);
  if (!row) return null;
  const response = await getBlob().servingResponse(row.path, row.mime);
  if (!response) return null;
  return { row, response };
}

// Best-effort blob deletion: log anything unexpected so an operator notices
// if the store is drifting out of sync with the DB.
export async function unlinkAttachmentFile(key: string): Promise<void> {
  await getBlob().delete(key);
}

// Convenience: delete in parallel and don't throw — the rows are already
// gone from the DB by the time this is called, so there's nothing to roll
// back to.
export async function unlinkAttachmentFiles(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await getBlob().deleteMany(keys);
}

// Periodic orphan sweep. Called from index.ts on startup; rearms itself.
// 15-minute default TTL means a very slow client still has time to post its
// chat message after uploading; faster sweeps would risk breaking retries.
export function startOrphanSweeper(intervalMs: number = 10 * 60 * 1000): void {
  const tick = async () => {
    try {
      const keys = deleteOrphanAttachments(15 * 60);
      if (keys.length > 0) {
        await unlinkAttachmentFiles(keys);
        console.log(`[attachments] swept ${keys.length} orphan(s)`);
      }
    } catch (e: any) {
      console.error('[attachments] sweep error:', e?.message ?? e);
    }
  };
  // Run once ~30s after boot so late startup tasks don't compete for I/O,
  // then at the configured interval.
  setTimeout(tick, 30_000);
  setInterval(tick, intervalMs);
}

// Kept for back-compat with callers that haven't been ported yet — returns
// the old `{row, absPath, size}` shape only when the local driver is in use.
// New code should prefer getAttachmentServingResponse.
export async function getAttachmentForServing(id: string): Promise<{
  row: AttachmentRow;
  response: Response;
} | null> {
  return getAttachmentServingResponse(id);
}
