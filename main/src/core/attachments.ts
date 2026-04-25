import { join } from 'path';
import { mkdir, unlink, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  createAttachment,
  findAttachmentById,
  deleteOrphanAttachments,
  type AttachmentRow,
} from '../db/queries';

// All attachments live under data/uploads/, bucketed by year-month to keep
// any single directory from ballooning. The file name is `<uuid>.<ext>` so
// URLs are stable and unguessable.
const ROOT = join(import.meta.dir, '../..');
const UPLOADS_ROOT = join(ROOT, 'data', 'uploads');

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

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

// Resolve a stored relative path (e.g. "2026-04/abc.png") to its absolute
// location on disk. Paths stored in the DB are always relative to
// UPLOADS_ROOT so the data directory can be moved without rewrites.
export function resolveAttachmentPath(relPath: string): string {
  return join(UPLOADS_ROOT, relPath);
}

// Serve file for a given attachment row, or null if the file is gone.
export async function readAttachmentFile(row: AttachmentRow): Promise<Uint8Array | null> {
  const abs = resolveAttachmentPath(row.path);
  try {
    const f = Bun.file(abs);
    if (!(await f.exists())) return null;
    const buf = await f.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
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
 * Persist an uploaded file to disk and create an orphan (message_id=NULL)
 * attachment row. The client later sends the returned id in the WS chat
 * payload to bind it to a message.
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
  const relPath = `${bucket}/${id}.${ext}`;
  const absPath = join(UPLOADS_ROOT, bucket, `${id}.${ext}`);

  await ensureDir(join(UPLOADS_ROOT, bucket));
  await writeFile(absPath, bytes);

  createAttachment(
    id,
    args.conversationId ?? null,
    'image',
    normMime,
    relPath,
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

// Best-effort file deletion: swallow ENOENT but log anything else so an
// operator notices if the filesystem is drifting out of sync with the DB.
export async function unlinkAttachmentFile(relPath: string): Promise<void> {
  const abs = resolveAttachmentPath(relPath);
  try {
    await unlink(abs);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn(`[attachments] failed to unlink ${abs}:`, e?.message ?? e);
    }
  }
}

// Convenience: unlink in parallel and don't throw — the rows are already gone
// from the DB by the time this is called, so there's nothing to roll back to.
export async function unlinkAttachmentFiles(relPaths: string[]): Promise<void> {
  if (relPaths.length === 0) return;
  await Promise.all(relPaths.map(p => unlinkAttachmentFile(p)));
}

// Periodic orphan sweep. Called from index.ts on startup; rearms itself.
// 15-minute default TTL means a very slow client still has time to post its
// chat message after uploading; faster sweeps would risk breaking retries.
export function startOrphanSweeper(intervalMs: number = 10 * 60 * 1000): void {
  const tick = async () => {
    try {
      const paths = deleteOrphanAttachments(15 * 60);
      if (paths.length > 0) {
        await unlinkAttachmentFiles(paths);
        console.log(`[attachments] swept ${paths.length} orphan(s)`);
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

// Light-touch helper for the /uploads/<id> static route.
export async function getAttachmentForServing(id: string): Promise<{
  row: AttachmentRow;
  absPath: string;
  size: number;
} | null> {
  const row = findAttachmentById(id);
  if (!row) return null;
  const absPath = resolveAttachmentPath(row.path);
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return null;
    return { row, absPath, size: s.size };
  } catch {
    return null;
  }
}
