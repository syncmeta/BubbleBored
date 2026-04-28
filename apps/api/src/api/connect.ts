import { Hono } from 'hono';
import { findInviteByToken } from '../db/queries';

/**
 * Invite-link landing + AASA. Mounted at root:
 *
 *   GET  /i/:token                                 → invite redirect
 *   GET  /.well-known/apple-app-site-association   → Universal Links
 *
 * The historical "iOS share link" namespace (api_keys.share_token →
 * landing-page → deep-link the app → /api/connect/redeem) is gone. iOS now
 * uses Clerk for hosted onboarding; admins still issue invites for self-host
 * users via the standard /api/invites/redeem flow that the web client owns.
 *
 * This file used to render a fancy in-WeChat landing page with App Store
 * fallbacks; with the share-token flow removed, /i/<token> only ever needs
 * to bounce a still-valid invite into the SPA — the SPA's login form does
 * the actual redeem.
 */
export const connectRoutes = new Hono();

// ── Invite landing ─────────────────────────────────────────────────────────

connectRoutes.get('/i/:token', (c) => {
  const token = c.req.param('token');
  const inv = findInviteByToken(token);
  // Bootstrap invites stay reusable — ignore redeemed_at for that namespace.
  const inviteUsable = inv
    && (!inv.redeemed_at || inv.id.startsWith('bootstrap_'))
    && (!inv.expires_at || inv.expires_at >= Math.floor(Date.now() / 1000));

  if (inviteUsable) {
    // Bounce to the SPA so the existing app shell can render the redeem
    // form; cookie isn't set yet, so the SPA's /api/me probe will 401 and
    // the login screen takes over with the token pre-filled in the URL.
    return c.redirect(`/?invite=${encodeURIComponent(token)}`, 302);
  }

  return c.html(`<!doctype html><meta charset="utf-8"><title>链接无效</title>
    <body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center;color:#666">
    <h1 style="font-size:48px;margin:0">⚠️</h1>
    <p>这条链接已失效、已被使用或已撤销</p>
    <p style="font-size:13px">请联系发送者重新生成</p></body>`, 404);
});

// ── Apple App Site Association (Universal Links) ────────────────────────────
//
// Apple expects this exact path served as application/json (no .json
// suffix, no auth, no redirects) — Cloudflare's "Always use HTTPS" + the
// full-strict origin chain we set up are fine because Apple does follow
// HTTPS, but the response body itself must be reachable in one shot.
//
// The Team ID prefix has to match the iOS team that signs the binary; it
// can be set at deploy time via the APPLE_TEAM_ID env var so dev / prod
// can sign under different teams without rebuilding.

const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'TEAMID';
const IOS_BUNDLE_ID = 'com.pendingname.bot';

connectRoutes.get('/.well-known/apple-app-site-association', (c) => {
  c.header('Content-Type', 'application/json');
  return c.body(JSON.stringify({
    applinks: {
      details: [{
        appIDs: [`${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`],
        components: [{ '/': '/i/*' }],
      }],
    },
  }));
});
