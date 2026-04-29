import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'crypto';
import {
  createUser, createApiKey, findApiKeyById, findUserById,
  listApiKeys, revokeApiKey, deleteUserCascade,
} from '../db/queries';
import { hashApiKey, base64UrlEncode, requireAdminMiddleware } from './_helpers';
import { unlinkAttachmentFiles } from '../core/attachments';

/**
 * Admin-only api-key minting. iOS onboarding now goes through Clerk
 * (`/api/auth/clerk/exchange`), so the legacy "scan/login-code" flow that
 * this used to power has been retired along with the share-token columns.
 * What remains: a programmatic way for an admin to mint a long-lived bearer
 * token bound to a fresh users row — handy for curl / scripts / future
 * bot integrations that don't have a Clerk identity to exchange.
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
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

// ── List ────────────────────────────────────────────────────────────────────

keysRoutes.get('/', (c) => {
  return c.json(listApiKeys().map(publicShape));
});

// ── Create ──────────────────────────────────────────────────────────────────

keysRoutes.post('/', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? '').trim() || 'iPhone';

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
    createdBy: admin?.id ?? null,
  });

  return c.json({
    id: keyId,
    name,
    user_id: userId,
    key,                      // ⚠ shown ONCE — never returned again
    key_prefix: key.slice(0, KEY_PREFIX_DISPLAY_LEN),
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
