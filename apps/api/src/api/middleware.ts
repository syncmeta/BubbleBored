import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

// ── CORS ──────────────────────────────────────────────────────────────────
//
// CORS_ALLOWED_ORIGINS is a comma-separated allowlist of exact origins. When
// set, only those origins receive CORS headers; others get an opaque 403 on
// preflight. Empty / unset → wildcard for dev convenience (matches the prior
// "no CORS at all" behavior, just with the headers explicit).
//
// In production (NODE_ENV=production or FLY_APP_NAME set) the wildcard is a
// real CSRF risk — any origin with `credentials: include` could exercise the
// authenticated API on behalf of a logged-in user. We refuse to start in that
// case so a forgotten env var becomes a noisy boot failure, not a quiet
// security hole.
//
// Native iOS clients send no Origin header (URLSession + WS), so they bypass
// this entirely — they just don't get gated.

const allowed = (() => {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) {
    if (process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS must be set in production. ' +
        'Set it to a comma-separated list of allowed origins (e.g. "https://bot.pendingname.com").'
      );
    }
    return null;
  }
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
})();

export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin');
  const isPreflight = c.req.method === 'OPTIONS';

  if (origin) {
    const ok = !allowed || allowed.has(origin);
    if (ok) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Max-Age', '600');
    } else if (isPreflight) {
      return c.body(null, 403);
    }
  }

  if (isPreflight) return c.body(null, 204);
  return next();
};

// ── Per-user rate limit ───────────────────────────────────────────────────
//
// Sliding-window in-memory limiter keyed on the resolved auth user id. Sits
// behind apiKeyAuthMiddleware so we always have an id to key on. Cloudflare
// is the first line of defense for unauthenticated abuse — this is the
// "stop a buggy authenticated client from looping forever" backstop.
//
// Bound: the map is capped at MAX_BUCKETS with insertion-order eviction
// (oldest entry dropped when full). Combined with the periodic GC below,
// this gives a hard memory ceiling regardless of unique user volume — useful
// against pathological scenarios (e.g. abusive client cycling identities,
// or a sudden burst of new users mid-window before GC runs).
//
// NOTE: per-process state. With multiple machines the effective limit is
// RATE_LIMIT_PER_MIN × N. The plan calls out moving this to Redis / Workers
// KV before horizontal scaling — this implementation is the single-instance
// backstop only.

interface Bucket { windowStart: number; count: number }
const buckets = new Map<string, Bucket>();

const RATE_LIMIT_PER_MIN = (() => {
  const raw = process.env.RATE_LIMIT_PER_MIN;
  const v = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 60;
})();
const WINDOW_MS = 60_000;
const MAX_BUCKETS = (() => {
  const raw = process.env.RATE_LIMIT_MAX_BUCKETS;
  const v = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 50_000;
})();

export const userRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const user = c.get('authUser');
  // No user = either a public path (whitelist) or auth already 401'd. Either
  // way nothing to limit on.
  if (!user) return next();

  const now = Date.now();
  let b = buckets.get(user.id);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    // Evict oldest if we're about to exceed the cap. Maps preserve insertion
    // order, so the first-iter key is the oldest. Cheap O(1) per overflow.
    if (!b && buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    b = { windowStart: now, count: 0 };
    buckets.set(user.id, b);
  }
  b.count += 1;
  if (b.count > RATE_LIMIT_PER_MIN) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - b.windowStart)) / 1000);
    c.header('Retry-After', String(retryAfter));
    throw new HTTPException(429, { message: 'rate limit exceeded' });
  }
  return next();
};

// Periodic GC so the map doesn't grow without bound between requests.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [k, b] of buckets) if (b.windowStart < cutoff) buckets.delete(k);
}, WINDOW_MS).unref?.();

// ── Per-IP rate limit (public endpoints) ──────────────────────────────────
//
// Used to gate unauthenticated paths like /api/invites/redeem and
// /api/invites/check/<token> where there's no user_id to key on. Keeps the
// abuse surface (token enumeration, brute-force on share links) bounded
// without requiring Cloudflare to know about every public endpoint.
//
// Honors x-forwarded-for / cf-connecting-ip when present so we get the real
// client IP behind Cloudflare → Fly. Falls back to the socket peer otherwise.

const ipBuckets = new Map<string, Bucket>();
const MAX_IP_BUCKETS = 50_000;

function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  // Bun's request handler stuffs the socket peer onto fetch's second arg
  // (see index.ts: `app.fetch(req, { ip: server.requestIP(req) })`); Hono
  // passes that through as c.env. Fall back to a literal in dev.
  const ip = (c.env as any)?.ip;
  if (ip && typeof ip === 'object' && typeof ip.address === 'string') return ip.address;
  return 'unknown';
}

export function ipRateLimitMiddleware(perMinute: number): MiddlewareHandler {
  return async (c, next) => {
    const ip = clientIp(c);
    const now = Date.now();
    let b = ipBuckets.get(ip);
    if (!b || now - b.windowStart >= WINDOW_MS) {
      if (!b && ipBuckets.size >= MAX_IP_BUCKETS) {
        const oldest = ipBuckets.keys().next().value;
        if (oldest !== undefined) ipBuckets.delete(oldest);
      }
      b = { windowStart: now, count: 0 };
      ipBuckets.set(ip, b);
    }
    b.count += 1;
    if (b.count > perMinute) {
      const retryAfter = Math.ceil((WINDOW_MS - (now - b.windowStart)) / 1000);
      c.header('Retry-After', String(retryAfter));
      throw new HTTPException(429, { message: 'rate limit exceeded' });
    }
    return next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [k, b] of ipBuckets) if (b.windowStart < cutoff) ipBuckets.delete(k);
}, WINDOW_MS).unref?.();
