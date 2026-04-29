import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'crypto';
import {
  getUserSettings, setOpenrouterByok, setJinaByok,
  getMeta, setMeta,
} from '../db/queries';
import type { UserSettingsRow } from '../db/queries';

// AES-256-GCM at-rest encryption for user-supplied API keys (OpenRouter, Jina).
// The KEK is derived from BYOK_ENC_KEY; if unset we fall back to a process-
// scoped random key, which means BYOK values won't survive a restart — fine
// in dev, broken in prod. Production deploys MUST set BYOK_ENC_KEY to a
// stable 32+ byte secret.
//
// KEK stability check (v30+): the first time we see a real BYOK_ENC_KEY we
// store HMAC-SHA256(kek, "byok-kek-fingerprint-v1") in the meta table. On
// every later boot we recompute and compare. Mismatch = silent key rotation
// would corrupt every encrypted column → we throw and refuse to start. The
// stored value reveals nothing about the key (HMAC of a fixed string with a
// 32-byte PRF input is not feasibly invertible), so it's safe at rest.
//
// To intentionally rotate: re-encrypt user_settings with the new key, then
// DELETE FROM meta WHERE k='byok_kek_fp' before starting under the new key.

const ALG = 'aes-256-gcm';
const KEK_FP_KEY = 'byok_kek_fp';
const KEK_FP_DOMAIN = 'byok-kek-fingerprint-v1';

function fingerprint(kek: Buffer): string {
  return createHmac('sha256', kek).update(KEK_FP_DOMAIN, 'utf8').digest('hex');
}

let cachedKey: Buffer | null = null;
function getKek(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BYOK_ENC_KEY;
  if (!raw) {
    console.warn('[byok] BYOK_ENC_KEY not set — using ephemeral key, BYOK values will not survive restart');
    cachedKey = randomBytes(32);
    // Ephemeral key intentionally skips the fingerprint check — every restart
    // is a "rotation" and there's no persisted ciphertext that matters anyway.
    return cachedKey;
  }
  // Hash the secret so any length input becomes a valid 32-byte key.
  cachedKey = createHash('sha256').update(raw, 'utf8').digest();
  const fp = fingerprint(cachedKey);
  const stored = getMeta(KEK_FP_KEY);
  if (stored === null) {
    setMeta(KEK_FP_KEY, fp);
    console.log('[byok] KEK fingerprint recorded');
  } else if (stored !== fp) {
    // Wipe the cache so a caller catching this error can't accidentally
    // proceed with the wrong key on a subsequent call.
    cachedKey = null;
    throw new Error(
      '[byok] BYOK_ENC_KEY changed since last boot — every encrypted user_settings.* column would become unrecoverable. ' +
      'Restart with the original key, or (only if you have already re-encrypted user_settings under the new key) ' +
      "run: DELETE FROM meta WHERE k='byok_kek_fp';"
    );
  }
  return cachedKey;
}

// Layout: [12-byte iv | 16-byte tag | ciphertext]
function encrypt(plain: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, getKek(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, ct]));
}

function decrypt(blob: Uint8Array | Buffer): string | null {
  try {
    const buf = Buffer.from(blob);
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv(ALG, getKek(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4);
}

// Eager startup check — call from index.ts after the DB is ready so
// fingerprint mismatch surfaces as a startup crash rather than a deferred
// failure on the first BYOK request.
export function verifyKekFingerprint(): void {
  getKek();
}

// ── public ─────────────────────────────────────────────────────────────────

export function saveOpenrouterByok(
  userId: string,
  raw: string | null,
  baseUrl: string | null = null,
): void {
  if (!raw) {
    setOpenrouterByok(userId, null, null, null);
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    setOpenrouterByok(userId, null, null, null);
    return;
  }
  const normalizedBase = baseUrl?.trim() ? baseUrl.trim() : null;
  setOpenrouterByok(userId, encrypt(trimmed), last4(trimmed), normalizedBase);
}

export function saveJinaByok(userId: string, raw: string | null): void {
  if (!raw) {
    setJinaByok(userId, null, null);
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    setJinaByok(userId, null, null);
    return;
  }
  setJinaByok(userId, encrypt(trimmed), last4(trimmed));
}

// Decrypted accessors. Cached per request via lookup; callers should not
// hold the plaintext beyond the immediate LLM/HTTP call. Returning null
// means "no BYOK configured, fall through to platform-provided key".

export function readOpenrouterByok(userId: string): string | null {
  const row = getUserSettings(userId);
  if (!row || !row.openrouter_key_enc) return null;
  return decrypt(row.openrouter_key_enc as any);
}

/// Companion to `readOpenrouterByok` — returns the user's chosen base URL
/// (e.g. https://api.openai.com/v1) or null when they're using OpenRouter.
export function readOpenrouterBaseUrl(userId: string): string | null {
  const row = getUserSettings(userId);
  return row?.openrouter_base_url ?? null;
}

export function readJinaByok(userId: string): string | null {
  const row = getUserSettings(userId);
  if (!row || !row.jina_key_enc) return null;
  return decrypt(row.jina_key_enc as any);
}

export function summarizeByok(userId: string): {
  openrouter: { configured: boolean; last4: string | null; baseUrl: string | null };
  jina: { configured: boolean; last4: string | null };
} {
  const row: UserSettingsRow | null = getUserSettings(userId);
  return {
    openrouter: {
      configured: !!row?.openrouter_key_enc,
      last4: row?.openrouter_key_last4 ?? null,
      baseUrl: row?.openrouter_base_url ?? null,
    },
    jina: {
      configured: !!row?.jina_key_enc,
      last4: row?.jina_key_last4 ?? null,
    },
  };
}
