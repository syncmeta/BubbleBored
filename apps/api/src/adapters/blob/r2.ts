import {
  S3Client, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobDriver } from './types';

// Cloudflare R2 blob driver. R2 is S3-compatible — we use the AWS SDK with
// a custom endpoint. Reads serve a 302 to a short-lived signed URL so bytes
// don't proxy through the Fly origin (saves egress + latency).

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Optional public read host. Set to an R2 custom domain you've configured
   * for the bucket (e.g. assets.pendingname.com) — when present we redirect
   * straight there instead of generating signed URLs, saving the SignBlob
   * round-trip and letting Cloudflare cache aggressively.
   */
  publicHost?: string;
}

function readConfigFromEnv(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicHost: process.env.R2_PUBLIC_HOST || undefined,
  };
}

export function makeR2BlobDriver(): BlobDriver | null {
  const cfg = readConfigFromEnv();
  if (!cfg) return null;

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  return {
    kind: 'r2',

    async put(key, bytes, mime) {
      await client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        // Attachment ids are immutable; long-cache hint for the CDN/browser.
        CacheControl: 'private, max-age=31536000, immutable',
      }));
    },

    async getBytes(key) {
      try {
        const res = await client.send(new GetObjectCommand({
          Bucket: cfg.bucket, Key: key,
        }));
        if (!res.Body) return null;
        // SDK Body is a stream — collect into a Uint8Array.
        const arr = await res.Body.transformToByteArray();
        return arr;
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null;
        throw e;
      }
    },

    async servingResponse(key, _mime) {
      // First check existence (HEAD) so we can return null → caller's 404.
      try {
        await client.send(new HeadObjectCommand({
          Bucket: cfg.bucket, Key: key,
        }));
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
        throw e;
      }

      if (cfg.publicHost) {
        const url = `https://${cfg.publicHost.replace(/\/+$/, '')}/${encodeURI(key)}`;
        return Response.redirect(url, 302);
      }

      const signedUrl = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
        { expiresIn: 60 * 5 }, // 5 minutes — covers slow page loads + retries
      );
      return Response.redirect(signedUrl, 302);
    },

    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: cfg.bucket, Key: key,
        }));
      } catch (e: any) {
        // S3 DELETE is idempotent — only log non-404 issues.
        if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound') {
          console.warn(`[blob/r2] failed to delete ${key}:`, e?.message ?? e);
        }
      }
    },

    async deleteMany(keys) {
      if (keys.length === 0) return;
      // We could use DeleteObjectsCommand for batches >1, but this code path
      // runs only on conv/user wipe — fan-out is fine and avoids the extra
      // serialization. Revisit if a single user has thousands of attachments.
      await Promise.all(keys.map(k => this.delete(k)));
    },
  };
}
