import type { EventEmitter } from 'events';
import type { Context, MiddlewareHandler } from 'hono';
import { createHash } from 'crypto';
import { HTTPException } from 'hono/http-exception';
import {
  findUserById, findBot, listBots,
  findConversationById, findApiKeyByHash, touchApiKey,
  type ApiKeyRow,
} from '../db/queries';

// Hono context variables we set from middleware. Augment the global Variables
// map so c.get('authUser') / c.set('authUser', …) is statically typed across
// every router.
declare module 'hono' {
  interface ContextVariableMap {
    authUser: {
      id: string;
      channel: string;
      external_id: string | null;
      display_name: string;
      status: string;
      is_admin: number;
      [k: string]: unknown;
    };
    authApiKey: ApiKeyRow;
  }
}
import { messageBus } from '../bus/router';
import { webChannel } from '../bus/channels/web';
import { iosChannel } from '../bus/channels/ios';
import type { OutboundMessage } from '../bus/types';
import type { FeatureType } from '../db/types';

// ── API key auth ────────────────────────────────────────────────────────────

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Resolve a raw api key to a user row. Returns null on any failure
// (unknown key, revoked key, deleted user).
export function resolveRawKey(key: string) {
  if (!key) return null;
  const row = findApiKeyByHash(hashApiKey(key));
  if (!row || row.revoked_at) return null;
  const user = findUserById(row.user_id);
  if (!user) return null;
  // fire-and-forget
  try { touchApiKey(row.id); } catch {}
  return { user, apiKey: row };
}

// Resolve a Bearer api key to a user row. Returns null on any failure
// (missing/malformed header, unknown key, revoked key, deleted user).
export function resolveApiKeyAuth(authHeader: string | undefined) {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return resolveRawKey(m[1].trim());
}

const SESSION_COOKIE = 'pb_session';

function readSessionCookie(c: Context): string | null {
  const raw = c.req.header('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function setSessionCookie(c: Context, key: string): void {
  // 30-day rolling session. SameSite=Lax keeps it on top-level navigation
  // but blocks cross-site POSTs — fine for our case (no cross-site flows).
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    { append: true },
  );
}

export function clearSessionCookie(c: Context): void {
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    { append: true },
  );
}

// Routes mounted under /api/* but reachable without a session. Onboarding
// flows have to be public because the caller has no credentials yet:
//   - /api/invites/redeem + /check/<token>  : web account creation
//   - /api/connect/redeem                    : iOS device pairing (the share
//     token is what the iOS app trades for a real api key)
// /api/health and /api/mobile/health are exempt for unauthenticated probes
// (the iOS app dials /api/mobile/health to check a server URL is reachable
// before it has a key — without this whitelist that probe 401s and the
// "find your server" UX breaks).
function isPublicApiPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname === '/api/mobile/health') return true;
  if (pathname === '/api/invites/redeem') return true;
  if (pathname.startsWith('/api/invites/check/')) return true;
  if (pathname === '/api/connect/redeem') return true;
  // Session install — accepts a raw api key and sets the pb_session cookie
  // server-side. Used as the recovery path when the cookie has been lost
  // (HttpOnly means JS in the browser can't write it directly).
  if (pathname === '/api/session/install') return true;
  return false;
}

// Global /api/* middleware. Resolves the caller from (in priority order):
//   1. Authorization: Bearer <key>   — iOS / programmatic clients
//   2. Cookie pb_session=<key>       — Web UI after invite redeem
// If neither resolves to a valid user, throws 401 unless the path is in the
// onboarding/health whitelist. Successful resolution stashes the user +
// api_key row on the context so handlers can read them via c.get('authUser').
export const apiKeyAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header('authorization');
  let resolved = auth ? resolveApiKeyAuth(auth) : null;
  if (!resolved) {
    const cookieKey = readSessionCookie(c);
    if (cookieKey) resolved = resolveRawKey(cookieKey);
  }

  if (resolved) {
    c.set('authUser', resolved.user);
    c.set('authApiKey', resolved.apiKey);
    return next();
  }

  // Reject Bearer tokens that we couldn't resolve (avoids the silent fallthrough
  // that would mask a stale/typoed key). Cookies are already cleared if
  // unparseable, so they don't need the same treatment.
  if (auth) throw new HTTPException(401, { message: 'invalid api key' });

  const path = new URL(c.req.url).pathname;
  if (isPublicApiPath(path)) return next();

  throw new HTTPException(401, { message: 'authentication required' });
};

// Legacy alias, kept so the mobile router wiring doesn't have to change.
// With the global middleware now hard-401ing on missing creds, any handler
// reachable here has already had its caller resolved — this is just an
// explicit "yes I require auth" marker on the mobile-only routes.
export const requireAuthMiddleware: MiddlewareHandler = async (c, next) => {
  if (!c.get('authUser')) throw new HTTPException(401, { message: 'authentication required' });
  return next();
};

// Admin-only routes (user management, global token audit) layer this on
// after the global middleware. Plain users get a clean 403 instead of a
// "huh, my data is missing" 200.
export const requireAdminMiddleware: MiddlewareHandler = async (c, next) => {
  const u = c.get('authUser');
  if (!u) throw new HTTPException(401, { message: 'authentication required' });
  if (!u.is_admin) throw new HTTPException(403, { message: 'admin only' });
  return next();
};

// ── User resolution ─────────────────────────────────────────────────────────

// Resolve the right reply path for a conversation:
//  1. If a channel is currently bound (user spoke recently), use it directly.
//  2. Otherwise look up the user's channel + external id from the DB and
//     send via the matching channel (web or ios). Using conv.user_id
//     (internal UUID) wouldn't match the WS connection key.
//  3. If nothing matches, drop silently (the conv just won't update live).
export function makeReplyFn(conv: { id: string; user_id: string }): (msg: OutboundMessage) => void {
  const bound = messageBus.getReplyFn(conv.id);
  if (bound) return bound;
  const user = findUserById(conv.user_id);
  if (!user) return () => {};
  const channel = user.channel;
  const externalId = user.external_id ?? null;
  return (msg: OutboundMessage) => {
    if (!externalId) return;
    if (channel === 'ios') iosChannel.send(externalId, msg).catch(() => {});
    else webChannel.send(externalId, msg).catch(() => {});
  };
}

// Mutation-side user resolution. The global middleware has already
// authenticated the caller — handlers always get the cookie/Bearer-resolved
// user. The `_unused` parameter is kept so existing call sites compile
// without churn; the value is intentionally ignored (clients can't pick
// who they are).
export function getOrCreateUser(c: Context, _unused?: string) {
  const authUser = c.get('authUser');
  if (!authUser) throw new HTTPException(401, { message: 'authentication required' });
  return authUser;
}

// Read-side user resolution. Same story: auth is already enforced at the
// middleware layer, so this is just a typed accessor.
export function findUser(c: Context): any {
  const authUser = c.get('authUser');
  if (!authUser) throw new HTTPException(401, { message: 'authentication required' });
  return authUser;
}

// ── Bot resolution ──────────────────────────────────────────────────────────

// "Explicit botId → inherit from source conv → first configured bot" chain
// shared by surf / review / debate / portrait creation routes.
export function resolveBotId(opts: {
  explicit?: string;
  fromSourceConvId?: string | null;
}): string {
  if (opts.explicit && findBot(opts.explicit)) return opts.explicit;
  if (opts.fromSourceConvId) {
    const src = findConversationById(opts.fromSourceConvId);
    if (src?.bot_id) return src.bot_id;
  }
  const bots = listBots();
  if (bots.length === 0) {
    throw new HTTPException(500, { message: 'no bots configured' });
  }
  return bots[0].id as string;
}

// ── SSE ─────────────────────────────────────────────────────────────────────

// Standard SSE handler that streams `log` and `done` events from an
// EventEmitter to the client, with an optional `init` payload sent on open.
export function sseStream(
  emitter: EventEmitter,
  abortSignal: AbortSignal,
  init?: () => unknown,
): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      const onLog = (data: unknown) => send('log', data);
      const onDone = (data: unknown) => send('done', data);
      emitter.on('log', onLog);
      emitter.on('done', onDone);
      send('init', init ? init() : {});
      abortSignal.addEventListener('abort', () => {
        emitter.off('log', onLog);
        emitter.off('done', onDone);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── Misc ────────────────────────────────────────────────────────────────────

// Type guard for routes that operate on a specific feature_type. Throws 400
// if the conv exists but is the wrong kind. Caller has already verified the
// conv is non-null. The generic preserves the rest of the row's properties
// (queries return rows typed as `any`, so we don't lose `id`/`user_id`/etc.).
export function assertFeatureType<C extends { feature_type: string }, T extends FeatureType>(
  conv: C,
  expected: T,
): asserts conv is C & { feature_type: T } {
  if (conv.feature_type !== expected) {
    throw new HTTPException(400, { message: `not a ${expected} conv` });
  }
}

// base64url encode/decode utilities for share-link payloads.
export function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
