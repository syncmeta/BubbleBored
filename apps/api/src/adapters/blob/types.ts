// BlobDriver — pluggable backend for user-uploaded files (chat image
// attachments, profile avatars in the future). Two implementations:
//
//   - local fs   (default; what self-host runs)
//   - Cloudflare R2 / any S3-compatible (hosted; survives Fly redeploys)
//
// Driver is picked at startup by adapters/blob/index.ts based on env vars.
// Code that touches uploads imports the driver via getBlob() and never
// references local paths or S3 SDKs directly.

export interface BlobDriver {
  /**
   * Store raw bytes under `key`. `key` is a path-style identifier that the
   * driver may interpret as either a filesystem path (relative to its data
   * dir) or an S3 object key — callers should use shape "yyyy-mm/<uuid>.<ext>".
   */
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;

  /**
   * Read raw bytes for `key`. Used by the vision prompt path that has to
   * embed the image into the LLM payload — there's no way to pass a URL
   * across providers, so we genuinely need the bytes server-side. Returns
   * null when the object is missing.
   *
   * Avoid this for serving HTTP responses — prefer servingResponse, which
   * lets R2 redirect instead of streaming through the API origin.
   */
  getBytes(key: string): Promise<Uint8Array | null>;

  /**
   * Build a Response that serves the object at `key`. Local driver returns a
   * 200 with body bytes; R2 driver returns a 302 redirect to a short-lived
   * signed URL (so bytes don't proxy through Fly). Returns null if the
   * object is missing — caller should map to 404.
   *
   * Caller controls Cache-Control on its own response wrapper; the driver
   * just supplies Content-Type / Content-Length where it can.
   */
  servingResponse(key: string, mime: string): Promise<Response | null>;

  /**
   * Remove the object. Idempotent: missing object is not an error.
   */
  delete(key: string): Promise<void>;

  /** Bulk delete; default impl is fine for both backends. */
  deleteMany(keys: string[]): Promise<void>;

  /** Driver tag for logging — "local" or "r2". */
  readonly kind: 'local' | 'r2';
}
