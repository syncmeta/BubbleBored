import { Hono } from 'hono';
import { saveUpload, MAX_UPLOAD_BYTES, isSupportedImageMime } from '../core/attachments';

/**
 * Upload endpoint — client POSTs multipart/form-data with a `file` field and
 * optional `conversationId`. The server writes bytes to disk, creates an
 * orphan (message_id=NULL) attachment row, and returns `{ id, url, … }`.
 *
 * Client then includes the returned id in the WS chat payload
 * (`attachmentIds: [id]`); the server binds it to the user message row.
 */
export const uploadRoutes = new Hono();

uploadRoutes.post('/', async (c) => {
  // Hono's req.parseBody accepts multipart; we keep max size via content-length
  // + an explicit cap inside saveUpload. Don't trust the client's mime — Bun
  // reports the uploaded File's type which comes from the browser.
  const ct = c.req.header('content-length');
  if (ct && Number(ct) > MAX_UPLOAD_BYTES + 4096) {
    return c.json({ error: 'payload too large' }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch (e: any) {
    return c.json({ error: `parse failed: ${e?.message ?? e}` }, 400);
  }

  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: 'file field missing' }, 400);
  }

  const mime = file.type || 'application/octet-stream';
  if (!isSupportedImageMime(mime)) {
    return c.json({ error: `unsupported mime: ${mime}` }, 415);
  }

  const conversationId = typeof body.conversationId === 'string' && body.conversationId
    ? body.conversationId
    : null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await saveUpload({ bytes, mime, conversationId });

  if ('error' in result) {
    return c.json({ error: result.error }, 400);
  }
  return c.json(result);
});
