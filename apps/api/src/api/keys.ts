import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'crypto';
import {
  createUser, createApiKey, findApiKeyById, findUserById,
  listApiKeys, revokeApiKey,
  updateApiKeyShareUrls, deleteUserCascade,
} from '../db/queries';
import { hashApiKey, base64UrlEncode, requireAdminMiddleware } from './_helpers';
import { detectServerUrls } from './server-urls';
import { unlinkAttachmentFiles } from '../core/attachments';

/**
 * Keys management API. Powers the 钥匙 admin panel in the web UI.
 *
 * V1 deployment model: this is a self-hosted single-admin tool. The routes
 * are intentionally not gated — anyone who can reach the web UI can mint
 * keys. If you expose this server publicly, put it behind a reverse proxy
 * with auth (basic/IP allowlist/SSO/etc).
 *
 * Each key binds to a fresh `users` row with channel='ios' and
 * external_id=<random uuid>. Used to be the only path for iOS onboarding
 * (admin minted a key + login-code, user pasted it). The login-code flow
 * is gone now; this endpoint is mostly useful for programmatic clients
 * (curl / scripts / future bots) that need a long-lived bearer token.
 */
export const keysRoutes = new Hono();

// All key-management endpoints are admin-only. Each key mints a fresh
// users row, so a non-admin minting keys would be a backdoor for creating
// accounts outside the invite flow.
keysRoutes.use('*', requireAdminMiddleware);

const KEY_PREFIX_DISPLAY_LEN = 12;

function generateApiKey(): string {
  const raw = base64UrlEncode(randomBytes(32)).slice(0, 32);
  return `pbk_live_${raw}`;
}

function publicShape(row: ReturnType<typeof findApiKeyById>) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    user_id: row.user_id,
    share_base_url: row.share_base_url,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

// ── List ────────────────────────────────────────────────────────────────────

keysRoutes.get('/', (c) => {
  return c.json(listApiKeys().map(publicShape));
});

// ── Server URL options (powers the create-modal dropdown) ──────────────────

keysRoutes.get('/server-urls', (c) => {
  return c.json(detectServerUrls(c));
});

// ── Create ──────────────────────────────────────────────────────────────────

keysRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    name?: string;
    baseURL?: string;        // explicit override; if absent we use the detected primary
    altURLs?: string[];      // explicit fallback list
  }>();
  const name = (body.name ?? '').trim() || 'iPhone';

  // Resolve base + alternates. If the admin specified a baseURL, use it
  // and (by default) keep the rest of the detected options as alternates.
  // If they didn't specify, use detection's primary + alternates as-is.
  const detected = detectServerUrls(c);
  const baseURL = body.baseURL?.trim() || detected.primary;
  const altURLs = body.altURLs
    ?? detected.options.map(o => o.url).filter(u => u !== baseURL && !u.includes('localhost') && !u.includes('127.0.0.1'));

  const userId = randomUUID();
  const externalId = randomUUID();
  createUser(userId, 'ios', externalId, name);

  const key = generateApiKey();
  const keyId = randomUUID();

  const admin = c.get('authUser');
  createApiKey({
    id: keyId,
    keyPrefix: key.slice(0, KEY_PREFIX_DISPLAY_LEN),
    keyHash: hashApiKey(key),
    userId,
    name,
    shareToken: null,
    shareBaseUrl: baseURL,
    shareAltUrls: altURLs,
    createdBy: admin?.id ?? null,
  });

  return c.json({
    id: keyId,
    name,
    user_id: userId,
    key,                      // ⚠ shown ONCE — never returned again
    key_prefix: key.slice(0, KEY_PREFIX_DISPLAY_LEN),
    share_base_url: baseURL,
    share_alt_urls: altURLs,
  });
});

// Update the share base / alternates. Lets the admin "fix" a key whose
// stored server URLs point at the wrong network. Doesn't change the key
// itself — the holder's existing login keeps working.
keysRoutes.patch('/:id/share/urls', async (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ baseURL: string; altURLs?: string[] }>();
  if (!body.baseURL) return c.json({ error: 'baseURL required' }, 400);
  updateApiKeyShareUrls(row.id, body.baseURL.trim(), body.altURLs ?? []);
  return c.json({
    share_base_url: body.baseURL,
    share_alt_urls: body.altURLs ?? [],
  });
});

// ── Revoke ──────────────────────────────────────────────────────────────────
//
// Revoking an iOS key also wipes the holder's data — chats, portraits, audit,
// attachments, the lot. Each key was minted with its own fresh users row, so
// "revoke key" and "delete user" are the same action by design.
//
// Admin users are an exception: their `users` row may also be the entry point
// the admin themselves uses, so we soft-revoke the key and leave the account
// intact. Use the recovery script (scripts/reset-admin-key.ts) if the admin
// loses their key — don't try to clean it up through this endpoint.

keysRoutes.delete('/:id', (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);

  const target = findUserById(row.user_id);
  if (target?.is_admin) {
    revokeApiKey(row.id);
    return c.json({ ok: true, mode: 'revoke' });
  }

  const paths = deleteUserCascade(row.user_id);
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true, mode: 'purge' });
});
