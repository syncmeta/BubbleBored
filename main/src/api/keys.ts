import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'crypto';
import QRCode from 'qrcode';
import {
  createUser, createApiKey, findApiKeyById,
  listApiKeys, revokeApiKey, rotateApiKeyShareToken,
  updateApiKeyShareUrls,
} from '../db/queries';
import { hashApiKey, base64UrlEncode, requireAdminMiddleware } from './_helpers';
import { detectServerUrls } from './server-urls';

/**
 * Keys management API. Powers the 钥匙 admin panel in the web UI.
 *
 * V1 deployment model: this is a self-hosted single-admin tool. The routes
 * are intentionally not gated — anyone who can reach the web UI can mint
 * keys. If you expose this server publicly, put it behind a reverse proxy
 * with auth (basic/IP allowlist/SSO/etc).
 *
 * Each key binds to a fresh `users` row with channel='ios' and
 * external_id=<random uuid>. The WS layer keys connections by external_id,
 * so the iOS WebSocket /ws/mobile?key=K resolves to that external_id and
 * existing iosChannel.send paths keep working unchanged.
 *
 * Share URLs are NOT derived from the admin's request host. Each key
 * remembers its own share_base_url (and optional alternates) so a key
 * minted from `localhost:3456` can still ship a working share URL — the
 * admin picks the public/LAN address from a dropdown at create time.
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

function generateShareToken(): string {
  return base64UrlEncode(randomBytes(16));
}

function publicShape(row: ReturnType<typeof findApiKeyById>) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    user_id: row.user_id,
    has_share_link: !!row.share_token,
    share_base_url: row.share_base_url,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

/// Build the share URL for a key. Prefers the per-key share_base_url that
/// the admin chose at create time; falls back to the request host so legacy
/// rows (created before v15) still work.
function buildShareUrl(c: any, row: { share_base_url: string | null; share_token: string }): string {
  if (row.share_base_url) {
    return `${row.share_base_url.replace(/\/+$/, '')}/i/${row.share_token}`;
  }
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}/i/${row.share_token}`;
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
  const shareToken = generateShareToken();

  const admin = c.get('authUser');
  createApiKey({
    id: keyId,
    keyPrefix: key.slice(0, KEY_PREFIX_DISPLAY_LEN),
    keyHash: hashApiKey(key),
    userId,
    name,
    shareToken,
    shareBaseUrl: baseURL,
    shareAltUrls: altURLs,
    createdBy: admin?.id ?? null,
  });

  const row = findApiKeyById(keyId);
  return c.json({
    id: keyId,
    name,
    user_id: userId,
    key,                      // ⚠ shown ONCE — never returned again
    key_prefix: key.slice(0, KEY_PREFIX_DISPLAY_LEN),
    share_url: row ? buildShareUrl(c, row as any) : '',
    share_base_url: baseURL,
    share_alt_urls: altURLs,
    share_token: shareToken,
  });
});

// ── Get share URL (no key, just the share token) ────────────────────────────

keysRoutes.get('/:id/share', (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.revoked_at) return c.json({ error: 'revoked' }, 410);
  if (!row.share_token) return c.json({ error: 'no share token' }, 404);
  return c.json({
    share_url: buildShareUrl(c, row as any),
    share_token: row.share_token,
    share_base_url: row.share_base_url,
  });
});

// QR code for the share URL — SVG so it scales crisp at any size and embeds
// in the admin panel without a round-trip per resize. Returns 404 if the
// key has no current share token (revoked, or admin chose to clear it).
keysRoutes.get('/:id/qr', async (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row || row.revoked_at || !row.share_token) {
    return c.text('not found', 404);
  }
  const svg = await QRCode.toString(buildShareUrl(c, row as any), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'no-store');
  return c.body(svg);
});

// Rotate the share token — invalidates the old share URL without changing
// the underlying api key. Use when a share link leaks but the recipient
// hasn't redeemed it yet (or you want to re-issue).
keysRoutes.post('/:id/share/rotate', (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.revoked_at) return c.json({ error: 'revoked' }, 410);
  const newToken = generateShareToken();
  rotateApiKeyShareToken(row.id, newToken);
  const fresh = findApiKeyById(row.id);
  return c.json({
    share_url: fresh ? buildShareUrl(c, fresh as any) : '',
    share_token: newToken,
    share_base_url: row.share_base_url,
  });
});

// Update the share base / alternates without rotating the token. Lets the
// admin "fix" a key whose share URL points at the wrong network.
keysRoutes.patch('/:id/share/urls', async (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ baseURL: string; altURLs?: string[] }>();
  if (!body.baseURL) return c.json({ error: 'baseURL required' }, 400);
  updateApiKeyShareUrls(row.id, body.baseURL.trim(), body.altURLs ?? []);
  const fresh = findApiKeyById(row.id);
  return c.json({
    share_url: fresh ? buildShareUrl(c, fresh as any) : '',
    share_base_url: body.baseURL,
    share_alt_urls: body.altURLs ?? [],
  });
});

// ── Revoke ──────────────────────────────────────────────────────────────────

keysRoutes.delete('/:id', (c) => {
  const row = findApiKeyById(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  revokeApiKey(row.id);
  return c.json({ ok: true });
});
