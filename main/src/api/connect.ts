import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import {
  findApiKeyByShareToken, findUserById, findInviteByToken,
} from '../db/queries';
import { base64UrlEncode, hashApiKey } from './_helpers';
import { getDb } from '../db/index';

/**
 * Share-link landing + redeem.
 *
 * Mounted at root:
 *   GET  /i/:token                            → HTML landing page (deep-link)
 *   POST /api/connect/redeem                  → exchange token → api key
 *   GET  /.well-known/apple-app-site-association  → AASA for Universal Links
 *
 * Flow:
 *   1. Admin creates a key → gets a share URL `http://<host>/i/<token>`.
 *   2. They send that URL via WeChat / SMS / etc.
 *   3. Recipient taps the link on iPhone:
 *        a. App installed + Universal Link active → app opens directly,
 *           reads the token out of the URL path, posts to /api/connect/redeem.
 *        b. App not installed (or UL blocked, e.g. WeChat in-app browser):
 *           the HTML page renders with an "open in app" button (custom URL
 *           scheme) and a "open in Safari" hint when running in WeChat.
 *   4. /api/connect/redeem mints a fresh api key for the user behind the
 *      token, clears the token, and returns { server, key, name }.
 *
 * The raw key NEVER appears in the share URL — only an opaque token.
 */
export const connectRoutes = new Hono();

const APP_SCHEME = 'pendingbot';

function reqHostUrl(c: any): string {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}

/// Resolve the base URL we should hand to the iOS client for this key.
/// Prefers the per-key share_base_url that the admin chose; falls back to
/// the URL the request is hitting (legacy keys, manual URL fetches).
function resolveBaseUrl(c: any, row: { share_base_url: string | null }): string {
  return row.share_base_url?.replace(/\/+$/, '') ?? reqHostUrl(c);
}

function resolveAltUrls(row: { share_alt_urls_json: string | null }): string[] {
  if (!row.share_alt_urls_json) return [];
  try {
    const parsed = JSON.parse(row.share_alt_urls_json);
    if (Array.isArray(parsed)) return parsed.filter(s => typeof s === 'string');
  } catch {}
  return [];
}

function landingHtml(token: string, host: string, isWechat: boolean): string {
  const deepLink = `${APP_SCHEME}://import?t=${encodeURIComponent(token)}&h=${encodeURIComponent(host)}`;
  const wechatHint = isWechat ? `
    <div class="hint">
      <p>📱 请点击右上角 <b>···</b> → <b>在 Safari 中打开</b></p>
      <p>这样才能正确跳转到大绿豆</p>
    </div>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>导入到大绿豆</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
           margin: 0; padding: 24px; max-width: 480px; margin-inline: auto;
           color: #1c1c1e; background: #f2f2f7; }
    @media (prefers-color-scheme: dark) {
      body { color: #fff; background: #000; }
      .card { background: #1c1c1e; }
      .btn-secondary { border-color: #38383a; color: #fff; }
    }
    h1 { font-size: 22px; margin: 24px 0 8px; }
    .sub { opacity: 0.6; font-size: 14px; margin-bottom: 24px; }
    .card { background: #fff; padding: 20px; border-radius: 16px; margin-bottom: 16px; }
    .btn { display: block; width: 100%; padding: 14px; border-radius: 12px;
           text-align: center; text-decoration: none; font-weight: 600;
           font-size: 16px; box-sizing: border-box; }
    .btn-primary { background: #007aff; color: #fff; margin-bottom: 12px; }
    .btn-secondary { background: transparent; color: #007aff; border: 1px solid #c6c6c8; }
    .hint { background: #fff3cd; color: #856404; padding: 16px;
            border-radius: 12px; margin-bottom: 16px; }
    @media (prefers-color-scheme: dark) {
      .hint { background: #3d3416; color: #ffd86b; }
    }
    code { font-family: ui-monospace, monospace; background: rgba(127,127,127,0.15);
           padding: 2px 6px; border-radius: 4px; word-break: break-all; }
    .meta { font-size: 13px; opacity: 0.6; margin-top: 32px; text-align: center; }
  </style>
</head>
<body>
  <h1>🌊 导入大绿豆服务器</h1>
  <p class="sub">将 <code>${host}</code> 添加到 iPhone 应用</p>
  ${wechatHint}
  <div class="card">
    <a class="btn btn-primary" href="${deepLink}">在大绿豆中打开</a>
  </div>
  <p class="meta">如果按钮无效,请把这条链接发到 iPhone 的 Safari 中打开</p>
  <script>
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !/MicroMessenger/.test(navigator.userAgent)) {
      setTimeout(() => { window.location.href = ${JSON.stringify(deepLink)}; }, 200);
    }
  </script>
</body>
</html>`;
}

// ── Landing page ────────────────────────────────────────────────────────────
//
// Two distinct token namespaces share the /i/<token> URL space:
//   1. api_keys.share_token  — iOS device pairing (existing flow)
//   2. invites.token         — web account onboarding (new)
//
// We dispatch by token type. iOS share tokens render the deep-link page
// (which tries to hand the token to the native app); invite tokens render
// a redirect to the SPA's /login route, which handles the form + redeem.

connectRoutes.get('/i/:token', (c) => {
  const token = c.req.param('token');

  const apiKeyRow = findApiKeyByShareToken(token);
  if (apiKeyRow && !apiKeyRow.revoked_at) {
    const ua = c.req.header('user-agent') ?? '';
    const isWechat = /MicroMessenger/i.test(ua);
    return c.html(landingHtml(token, reqHostUrl(c), isWechat));
  }

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

// ── Redeem ──────────────────────────────────────────────────────────────────
//
// We mint a brand-new api key on redeem rather than ever storing the raw key
// — only its SHA-256 lives in the DB. The api_keys row stays (so the admin
// dashboard shows the issuance history) but its hash gets replaced with the
// new key's hash and the share token is cleared (single-use). To re-share
// with the same recipient, the admin can rotate the share token from the
// panel; that does NOT change the underlying key.

connectRoutes.post('/api/connect/redeem', async (c) => {
  const body: { token?: string } = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const token = (body.token ?? '').trim();
  if (!token) return c.json({ error: 'token required' }, 400);

  const row = findApiKeyByShareToken(token);
  if (!row || row.revoked_at) return c.json({ error: 'invalid or expired token' }, 410);

  const user = findUserById(row.user_id);
  if (!user) return c.json({ error: 'user vanished' }, 410);

  const newKey = `pbk_live_${base64UrlEncode(randomBytes(32)).slice(0, 32)}`;
  getDb().query(
    `UPDATE api_keys SET key_hash = ?, key_prefix = ?, share_token = NULL,
       last_used_at = unixepoch() WHERE id = ?`
  ).run(hashApiKey(newKey), newKey.slice(0, 12), row.id);

  return c.json({
    // Primary URL the iOS client should use. Comes from what the admin
    // picked at create time, NOT from the request host — so a recipient
    // who tapped a share link redirected through some intermediate proxy
    // still gets the canonical address.
    server: resolveBaseUrl(c, row as any),
    // Fallback URLs the iOS client probes if `server` isn't reachable
    // from where it is — lets one share link work in both LAN and WAN
    // contexts when the admin set both.
    alt_servers: resolveAltUrls(row as any),
    key: newKey,
    name: row.name,
    user_id: row.user_id,
  });
});

// ── Apple App Site Association (Universal Links) ────────────────────────────
// Replace TEAMID + bundle id to match the iOS app you sign and ship.

connectRoutes.get('/.well-known/apple-app-site-association', (c) => {
  c.header('Content-Type', 'application/json');
  return c.body(JSON.stringify({
    applinks: {
      details: [{
        appIDs: ['TEAMID.com.pendingname.pendingbot'],
        components: [{ '/': '/i/*' }],
      }],
    },
  }));
});
