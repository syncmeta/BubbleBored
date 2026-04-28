import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

// ── CORS ──────────────────────────────────────────────────────────────────
//
// CORS_ALLOWED_ORIGINS is a comma-separated allowlist of exact origins. When
// set, only those origins receive CORS headers; others get an opaque 403 on
// preflight. Empty / unset → wildcard for dev convenience (matches the prior
// "no CORS at all" behavior, just with the headers explicit).
//
// Native iOS clients send no Origin header (URLSession + WS), so they bypass
// this entirely — they just don't get gated.

const allowed = (() => {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) return null;
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

interface Bucket { windowStart: number; count: number }
const buckets = new Map<string, Bucket>();

const RATE_LIMIT_PER_MIN = (() => {
  const raw = process.env.RATE_LIMIT_PER_MIN;
  const v = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 60;
})();
const WINDOW_MS = 60_000;

export const userRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const user = c.get('authUser');
  // No user = either a public path (whitelist) or auth already 401'd. Either
  // way nothing to limit on.
  if (!user) return next();

  const now = Date.now();
  let b = buckets.get(user.id);
  if (!b || now - b.windowStart >= WINDOW_MS) {
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

// Periodic GC so the map doesn't grow without bound.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [k, b] of buckets) if (b.windowStart < cutoff) buckets.delete(k);
}, WINDOW_MS).unref?.();
