import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { randomUUID, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createClerkClient, type User as ClerkUser } from '@clerk/backend';
import {
  createUser, createApiKey, findUserByClerkId, setUserClerkIdentity,
  findUserById, deleteUserCascade, listApiKeys,
  revokeApiKey, setUserDisplayName,
  type ClerkIdentityFields,
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
  // Default Clerk session JWTs do NOT include user fields like email or
  // first_name — only sub/iat/exp/nbf/azp. We accept these optional claims
  // anyway in case a custom JWT template was configured server-side; if
  // they're missing we fall back to the Clerk Backend SDK below.
  email?: string;
  primary_email_address?: string;
  email_address?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  image_url?: string;
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

// ── Clerk Backend SDK (server-to-Clerk) ────────────────────────────────────
//
// The default Clerk session JWT only contains sub/iat/exp — no email, no
// first_name, no image_url. Rather than asking every deployment to set up a
// custom JWT template just to populate the dashboard "我" tab, we hit the
// Clerk Backend API once per /clerk/exchange to fetch the full user record.
// Exchange isn't a hot path (runs on login), so the extra round-trip is
// fine. Falls back to JWT claims if CLERK_SECRET_KEY isn't configured (lets
// dev / self-host run with just the publishable key + JWKS).

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
function getClerkClient() {
  if (clerkClient) return clerkClient;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  clerkClient = createClerkClient({ secretKey });
  return clerkClient;
}

interface ClerkIdentitySnapshot {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string | null;
}

function emptySnapshot(): ClerkIdentitySnapshot {
  return { email: null, firstName: null, lastName: null, username: null, imageUrl: null };
}

function snapshotFromClerkUser(u: ClerkUser): ClerkIdentitySnapshot {
  // primaryEmailAddressId points at the verified primary; fall back to the
  // first listed address if the primary is somehow unset.
  const primary = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId)
    ?? u.emailAddresses[0];
  return {
    email: primary?.emailAddress ?? null,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    username: u.username ?? null,
    imageUrl: u.imageUrl ?? null,
  };
}

function snapshotFromClaims(c: ClerkClaims): ClerkIdentitySnapshot {
  return {
    email: c.email || c.primary_email_address || c.email_address || null,
    firstName: c.first_name || null,
    lastName: c.last_name || null,
    username: c.username || null,
    imageUrl: c.image_url || null,
  };
}

async function fetchClerkIdentity(
  claims: ClerkClaims,
): Promise<ClerkIdentitySnapshot> {
  const client = getClerkClient();
  if (client) {
    try {
      const u = await client.users.getUser(claims.sub);
      return snapshotFromClerkUser(u);
    } catch (e) {
      // Network blip / wrong secret key shouldn't block login — fall back
      // to whatever the JWT carried. The user gets a degraded display name
      // but still gets a usable session.
      console.warn('[clerk] users.getUser failed, falling back to JWT claims:', e);
    }
  }
  return snapshotFromClaims(claims);
}

// Pick the most human-friendly handle Clerk has for this user.
//   firstName + lastName   →   "Yi Zhang"
//   firstName              →   "Yi"
//   username               →   "yzhang"
//   email local part       →   "yzhang"   (from yzhang@example.com)
//   "用户"                 →   absolute last resort
function deriveDisplayName(snap: ClerkIdentitySnapshot): string {
  const full = [snap.firstName, snap.lastName]
    .map(s => s?.trim()).filter(Boolean).join(' ');
  if (full) return full;
  if (snap.username?.trim()) return snap.username.trim();
  const localPart = snap.email?.split('@')[0]?.trim();
  if (localPart) return localPart;
  return '用户';
}

// ── /api/auth/clerk/exchange ───────────────────────────────────────────────

authRoutes.post('/clerk/exchange', async (c) => {
  const body = await c.req.json<{ token?: string; clientHint?: string }>().catch(
    () => ({} as { token?: string; clientHint?: string }),
  );
  const token = (body.token ?? '').trim();
  if (!token) return c.json({ error: 'token required' }, 400);

  // The web SPA runs in a browser; iOS sends `clientHint: "ios"` so we can
  // tag new accounts with the right channel. Anything we don't recognise
  // falls back to 'web' (the original behaviour).
  const channel = body.clientHint === 'ios' ? 'ios' : 'web';

  let claims: ClerkClaims;
  try {
    claims = await verifyClerkJwt(token);
  } catch (e: any) {
    if (e instanceof HTTPException) throw e;
    return c.json({ error: 'invalid token', detail: String(e?.message ?? e) }, 401);
  }

  const clerkUserId = claims.sub;
  const snap = await fetchClerkIdentity(claims);
  const identityFields: ClerkIdentityFields = {
    clerkUserId,
    email: snap.email,
    firstName: snap.firstName,
    lastName: snap.lastName,
    username: snap.username,
    imageUrl: snap.imageUrl,
  };

  // Upsert: existing user keyed by clerk_user_id, otherwise create a fresh
  // users row. We always re-sync the Clerk-mirror columns so name / avatar
  // changes in Clerk propagate on the next login.
  let user = findUserByClerkId(clerkUserId);
  if (!user) {
    const id = randomUUID();
    const externalId = randomUUID();
    const display = deriveDisplayName(snap);
    createUser(id, channel, externalId, display);
    setUserClerkIdentity(id, identityFields);
    user = findUserById(id);
  } else {
    setUserClerkIdentity(user.id, identityFields);
    // If the user has never customised their handle (display_name still
    // matches whatever we wrote at signup), keep it tracking Clerk. If
    // they've edited it via PATCH /me/profile, leave it alone.
    const currentDisplay = user.display_name as string | null;
    const previousDerived = deriveDisplayName({
      email: user.email ?? null,
      firstName: user.first_name ?? null,
      lastName: user.last_name ?? null,
      username: user.username ?? null,
      imageUrl: null,
    });
    if (currentDisplay === previousDerived) {
      const next = deriveDisplayName(snap);
      if (next !== currentDisplay) setUserDisplayName(user.id, next);
    }
    user = findUserById(user.id);
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
    name: channel === 'ios' ? 'ios-session' : 'web-session',
    createdBy: null,
  });

  setSessionCookie(c, key);
  return c.json({
    ok: true,
    key,
    user: {
      id: user.id,
      display_name: user.display_name,
      email: user.email ?? null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      username: user.username ?? null,
      image_url: user.image_url ?? null,
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
