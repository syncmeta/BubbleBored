import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { randomUUID, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  createUser, createApiKey, findUserByClerkId, setUserClerkIdentity,
  findUserById, deleteUserCascade, listApiKeys,
  revokeApiKey,
} from '../db/queries';
import {
  hashApiKey, base64UrlEncode, setSessionCookie, clearSessionCookie,
} from './_helpers';
import { unlinkAttachmentFiles } from '../core/attachments';

// Clerk-backed auth bridge. The web/iOS clients perform login against Clerk
// directly (Sign in with Apple / Google / email code). They then POST the
// short-lived Clerk session JWT to /api/auth/clerk/exchange — we verify it
// against Clerk's JWKs, upsert a local user keyed by the Clerk subject, mint
// a long-lived `pbk_live_*` api key, and return it.
//
// This keeps the existing api-key-everywhere auth surface untouched: every
// downstream route still sees a Bearer token / pb_session cookie.

export const authRoutes = new Hono();

const KEY_PREFIX_DISPLAY_LEN = 12;

function generateApiKey(): string {
  const raw = base64UrlEncode(randomBytes(32)).slice(0, 32);
  return `pbk_live_${raw}`;
}

// ── Clerk JWT verification ─────────────────────────────────────────────────

// CLERK_ISSUER e.g. https://clerk.your-domain.com or https://<slug>.clerk.accounts.dev
// We resolve JWKs from `${issuer}/.well-known/jwks.json` (Clerk's public path).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (jwks) return jwks;
  const issuer = process.env.CLERK_ISSUER;
  if (!issuer) throw new HTTPException(500, { message: 'CLERK_ISSUER not configured' });
  jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`));
  return jwks;
}

interface ClerkClaims extends JWTPayload {
  sub: string;
  email?: string;
  primary_email_address?: string;
  email_address?: string;
}

async function verifyClerkJwt(token: string): Promise<ClerkClaims> {
  const issuer = process.env.CLERK_ISSUER;
  if (!issuer) throw new HTTPException(500, { message: 'CLERK_ISSUER not configured' });
  const audience = process.env.CLERK_AUDIENCE; // optional — set in Clerk JWT template
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer,
    audience: audience || undefined,
  });
  if (!payload.sub) throw new HTTPException(401, { message: 'jwt missing sub' });
  return payload as ClerkClaims;
}

function extractEmail(claims: ClerkClaims): string | null {
  return (
    claims.email
    || claims.primary_email_address
    || claims.email_address
    || null
  );
}

// ── /api/auth/clerk/exchange ───────────────────────────────────────────────

authRoutes.post('/clerk/exchange', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const token = (body.token ?? '').trim();
  if (!token) return c.json({ error: 'token required' }, 400);

  let claims: ClerkClaims;
  try {
    claims = await verifyClerkJwt(token);
  } catch (e: any) {
    if (e instanceof HTTPException) throw e;
    return c.json({ error: 'invalid token', detail: String(e?.message ?? e) }, 401);
  }

  const clerkUserId = claims.sub;
  const email = extractEmail(claims);

  // Upsert: existing user keyed by clerk_user_id, otherwise create a fresh
  // users row. New rows go onto channel='web' since this is the same surface
  // a web/iOS user would land on after Clerk login.
  let user = findUserByClerkId(clerkUserId);
  if (!user) {
    const id = randomUUID();
    const externalId = randomUUID();
    const display = email?.split('@')[0] || 'user';
    createUser(id, 'web', externalId, display);
    setUserClerkIdentity(id, clerkUserId, email);
    user = findUserById(id);
  } else if (email && user.email !== email) {
    setUserClerkIdentity(user.id, clerkUserId, email);
  }
  if (!user) return c.json({ error: 'user upsert failed' }, 500);

  // Mint a fresh api key for this login. We don't reuse old keys — every
  // exchange returns a usable token; old keys remain valid until the user
  // explicitly revokes them or deletes the account.
  const key = generateApiKey();
  const keyId = randomUUID();
  createApiKey({
    id: keyId,
    keyPrefix: key.slice(0, KEY_PREFIX_DISPLAY_LEN),
    keyHash: hashApiKey(key),
    userId: user.id,
    name: 'web-session',
    shareToken: null,
    shareBaseUrl: null,
    shareAltUrls: null,
    createdBy: null,
  });

  setSessionCookie(c, key);
  return c.json({
    ok: true,
    key,
    user: {
      id: user.id,
      display_name: user.display_name,
      email: email ?? user.email ?? null,
      is_admin: user.is_admin === 1,
    },
  });
});

// ── DELETE /api/account ────────────────────────────────────────────────────
//
// In-app deletion path required by App Store guideline 5.1.1(v). Wipes every
// row owned by the caller and unlinks every attachment from disk, then clears
// the session cookie. The Clerk-side identity is the user's responsibility to
// delete via the Clerk Account UI; we don't proxy that because it'd require
// holding Clerk admin credentials server-side just to purge an external row.
//
// Admins can't delete themselves through this endpoint — that would brick the
// instance. They have to demote first via the admin panel.

authRoutes.delete('/account', async (c) => {
  const auth = c.get('authUser');
  if (!auth) throw new HTTPException(401, { message: 'authentication required' });
  if (auth.is_admin) {
    return c.json({ error: 'admins must demote before deleting account' }, 403);
  }
  const paths = deleteUserCascade(auth.id);
  await unlinkAttachmentFiles(paths).catch(() => {});
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ── helper used by the public-path whitelist ──────────────────────────────

export const PUBLIC_AUTH_PATHS = new Set<string>([
  '/api/auth/clerk/exchange',
]);

// Suppress unused warnings for imports kept for future expansion (logout
// already lives in index.ts; revoke flows for other clients live in keys.ts).
void listApiKeys; void revokeApiKey;
