import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'crypto';
import {
  createInvite, listInvites, findInviteByToken, findInviteById,
  markInviteRedeemed, deleteInvite,
  createUser, createApiKey, countAdmins,
} from '../db/queries';
import {
  base64UrlEncode, hashApiKey, requireAdminMiddleware, setSessionCookie,
} from './_helpers';
import { ipRateLimitMiddleware } from './middleware';

/**
 * Invites: admin-issued onboarding tokens.
 *
 * Flow:
 *   1. Admin POST /api/invites → server returns { token, share_url }.
 *   2. Admin sends share_url out of band.
 *   3. Recipient lands on /i/<token> (handled in connect.ts), enters a
 *      display_name, submits to POST /api/invites/redeem.
 *   4. Server creates the user + an api_keys row, sets the pb_session
 *      cookie, returns lightweight user info. The raw key never touches
 *      the response body — we'd rather rely on the HttpOnly cookie than
 *      hope a JS client stashes it correctly.
 *
 * Bootstrap special case: if no admin exists yet, the first redeem flips
 * is_admin=1 on the new user. The server prints a one-shot bootstrap
 * invite link to stdout at startup when this is the case.
 */
export const invitesRoutes = new Hono();

const KEY_PREFIX_DISPLAY_LEN = 12;

// Bootstrap invites are minted at startup when no admin exists. They keep
// working forever so a self-host operator who loses the URL or wipes the
// browser can re-claim admin access on a fresh device. Detected by id
// prefix (set in index.ts).
function isBootstrapInvite(inv: { id: string }): boolean {
  return inv.id.startsWith('bootstrap_');
}

function generateInviteToken(): string {
  // 24-byte random → 32-char URL-safe string. Plenty of entropy for an
  // unguessable URL token; same shape as share tokens elsewhere.
  return base64UrlEncode(randomBytes(24));
}

function generateApiKey(): string {
  return `pbk_live_${base64UrlEncode(randomBytes(32)).slice(0, 32)}`;
}

function buildShareUrl(c: any, token: string): string {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}/i/${token}`;
}

// ── List + create + revoke (admin) ─────────────────────────────────────────

invitesRoutes.get('/', requireAdminMiddleware, (c) => {
  return c.json(listInvites().map(row => ({
    id: row.id,
    token: row.token,
    note: row.note,
    expires_at: row.expires_at,
    redeemed_at: row.redeemed_at,
    redeemed_by_user_id: row.redeemed_by_user_id,
    created_at: row.created_at,
    share_url: buildShareUrl(c, row.token),
  })));
});

invitesRoutes.post('/', requireAdminMiddleware, async (c) => {
  const body = await c.req.json<{ note?: string; expiresAt?: number }>().catch(() => ({} as any));
  const admin = c.get('authUser');

  const id = randomUUID();
  const token = generateInviteToken();
  createInvite({
    id, token,
    createdBy: admin.id,
    note: body.note?.trim() || null,
    expiresAt: body.expiresAt ?? null,
  });

  return c.json({
    id, token,
    share_url: buildShareUrl(c, token),
    expires_at: body.expiresAt ?? null,
  });
});

invitesRoutes.delete('/:id', requireAdminMiddleware, (c) => {
  const id = c.req.param('id');
  const inv = findInviteById(id);
  if (!inv) return c.json({ error: 'not found' }, 404);
  if (inv.redeemed_at) return c.json({ error: 'already redeemed' }, 410);
  deleteInvite(id);
  return c.json({ ok: true });
});

// ── Redeem (public) ────────────────────────────────────────────────────────
//
// Whitelisted in apiKeyAuthMiddleware so a brand-new visitor can call this
// without a cookie. Mints fresh user + api key in one go, sets cookie.

// 10 redeems / minute / IP — generous for a legitimate user retrying after
// a failed display-name validation, tight enough that scripted enumeration
// across IPs would have to commit serious infra. Cloudflare WAF is the real
// line of defense; this is the application-side belt-and-braces.
invitesRoutes.post('/redeem', ipRateLimitMiddleware(10), async (c) => {
  const body = await c.req.json<{ token?: string; displayName?: string }>().catch(() => ({} as any));
  const token = body.token?.trim();
  const displayName = body.displayName?.trim();
  if (!token) return c.json({ error: 'token required' }, 400);
  if (!displayName) return c.json({ error: 'displayName required' }, 400);

  const inv = findInviteByToken(token);
  if (!inv) return c.json({ error: 'invalid token' }, 410);
  const bootstrap = isBootstrapInvite(inv);
  if (inv.redeemed_at && !bootstrap) return c.json({ error: 'invite already used' }, 410);
  if (inv.expires_at && inv.expires_at < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'invite expired' }, 410);
  }

  // Bootstrap invites always mint admins (they're the recovery hatch for the
  // self-host operator). Other invites only flip is_admin when there's no
  // admin yet — historic safety net that a regular invite never trips today.
  const isAdmin = bootstrap || countAdmins() === 0;

  const userId = randomUUID();
  const externalId = randomUUID();
  createUser(userId, 'web', externalId, displayName, isAdmin);

  const rawKey = generateApiKey();
  const keyId = randomUUID();
  createApiKey({
    id: keyId,
    keyPrefix: rawKey.slice(0, KEY_PREFIX_DISPLAY_LEN),
    keyHash: hashApiKey(rawKey),
    userId,
    name: displayName,
    shareToken: null,
    shareBaseUrl: null,
    shareAltUrls: null,
    createdBy: null,
  });

  // Bootstrap invites stay reusable — don't burn the row.
  if (!bootstrap) markInviteRedeemed(inv.id, userId);
  setSessionCookie(c, rawKey);

  return c.json({
    user_id: userId,
    display_name: displayName,
    is_admin: isAdmin ? 1 : 0,
  });
});

// ── Lookup (public) ────────────────────────────────────────────────────────
//
// Lightweight check used by the /i/<token> landing page to render a sensible
// "claim this account" form. Returns 404 for unknown / used / expired so the
// page can show a helpful error instead of a redeem form.

invitesRoutes.get('/check/:token', ipRateLimitMiddleware(30), (c) => {
  const inv = findInviteByToken(c.req.param('token'));
  if (!inv) return c.json({ error: 'unknown' }, 404);
  if (inv.redeemed_at && !isBootstrapInvite(inv)) return c.json({ error: 'used' }, 410);
  if (inv.expires_at && inv.expires_at < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'expired' }, 410);
  }
  return c.json({ ok: true, note: inv.note });
});
