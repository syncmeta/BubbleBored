import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import {
  getUserSettings, setOpenrouterByok, setJinaByok,
  type UserSettingsRow,
} from '../db/queries';

// AES-256-GCM at-rest encryption for user-supplied API keys (OpenRouter, Jina).
// The KEK is derived from BYOK_ENC_KEY; if unset we fall back to a process-
// scoped random key, which means BYOK values won't survive a restart — fine
// in dev, broken in prod. Production deploys MUST set BYOK_ENC_KEY to a
// stable 32+ byte secret.

const ALG = 'aes-256-gcm';

let cachedKey: Buffer | null = null;
function getKek(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BYOK_ENC_KEY;
  if (!raw) {
    console.warn('[byok] BYOK_ENC_KEY not set — using ephemeral key, BYOK values will not survive restart');
    cachedKey = randomBytes(32);
  } else {
    // Hash the secret so any length input becomes a valid 32-byte key.
    cachedKey = createHash('sha256').update(raw, 'utf8').digest();
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

// ── public ─────────────────────────────────────────────────────────────────

export function saveOpenrouterByok(userId: string, raw: string | null): void {
  if (!raw) {
    setOpenrouterByok(userId, null, null);
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    setOpenrouterByok(userId, null, null);
    return;
  }
  setOpenrouterByok(userId, encrypt(trimmed), last4(trimmed));
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

export function readJinaByok(userId: string): string | null {
  const row = getUserSettings(userId);
  if (!row || !row.jina_key_enc) return null;
  return decrypt(row.jina_key_enc as any);
}

export function summarizeByok(userId: string): {
  openrouter: { configured: boolean; last4: string | null };
  jina: { configured: boolean; last4: string | null };
} {
  const row: UserSettingsRow | null = getUserSettings(userId);
  return {
    openrouter: {
      configured: !!row?.openrouter_key_enc,
      last4: row?.openrouter_key_last4 ?? null,
    },
    jina: {
      configured: !!row?.jina_key_enc,
      last4: row?.jina_key_last4 ?? null,
    },
  };
}
