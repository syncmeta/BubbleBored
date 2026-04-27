import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { HTTPException } from 'hono/http-exception';
import { configManager } from './config/loader';
import { getDb } from './db/index';
import { syncBots } from './bots/registry';
import { messageBus } from './bus/router';
import { webChannel } from './bus/channels/web';
import type { WebSocketData } from './bus/channels/web';
import { iosChannel } from './bus/channels/ios';
import type { IOSWebSocketData } from './bus/channels/ios';
import { apiRoutes } from './api/routes';
import { auditRoutes } from './api/audit';
import { chatApiRoutes } from './api/bots';
import { surfRoutes } from './api/surf';
import { reviewRoutes } from './api/review';
import { debateRoutes } from './api/debate';
import { portraitRoutes } from './api/portrait';
import { meRoutes } from './api/me';
import { skillsRoutes } from './api/skills';
import { openrouterRoutes } from './api/openrouter';
import { mobileApiRoutes } from './api/mobile';
import { uploadRoutes } from './api/upload';
import { keysRoutes } from './api/keys';
import { connectRoutes } from './api/connect';
import { invitesRoutes } from './api/invites';
import { adminRoutes } from './api/admin';
import {
  apiKeyAuthMiddleware, resolveApiKeyAuth, hashApiKey,
  clearSessionCookie,
} from './api/_helpers';
import {
  countAdmins, createInvite, findApiKeyByHash, findUserById,
  findConversationById, findLatestBootstrapInvite,
} from './db/queries';
import { randomUUID, randomBytes } from 'crypto';
import { base64UrlEncode } from './api/_helpers';
import { addMessage as debounceAdd } from './core/debounce';
import { handleUserMessage, signalNewMessage } from './core/orchestrator';
import { cancelPendingReview } from './core/review';
import { startSurfingScheduler } from './core/surfing/trigger';
import { startOrphanSweeper, getAttachmentForServing } from './core/attachments';
import { initHoncho } from './honcho/client';
import { runSurf, createSurfConversation } from './core/surfing/searcher';

// Initialize
await configManager.load();
console.log('[init] config loaded');

getDb();
console.log('[init] database ready');

// Bootstrap admin: mint (or recover) a reusable invite link. The token is
// printed on every startup so a self-host operator who lost the URL can
// re-claim admin access. Each redeem creates a new admin user (handled in
// invites.ts) — the link itself never expires or burns.
ensureBootstrapAdminInvite();

function ensureBootstrapAdminInvite() {
  let inv = findLatestBootstrapInvite();
  if (!inv) {
    const token = base64UrlEncode(randomBytes(24));
    const id = `bootstrap_${randomUUID().slice(0, 8)}`;
    // createInvite.createdBy is FK to users(id). With no users yet, route
    // the row through a synthetic "system" user so the FK holds.
    const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';
    if (!findUserById(SYSTEM_ID)) {
      getDb().query(
        `INSERT INTO users (id, channel, external_id, display_name, status, is_admin)
         VALUES (?, 'system', ?, 'system', 'system', 0)`
      ).run(SYSTEM_ID, SYSTEM_ID);
    }
    createInvite({
      id, token,
      createdBy: SYSTEM_ID,
      note: 'bootstrap admin invite',
      expiresAt: null,
    });
    inv = findLatestBootstrapInvite();
  }

  const cfg = configManager.get();
  const base = cfg.server.publicURL?.replace(/\/+$/, '')
    ?? `http://${cfg.server.host === '0.0.0.0' ? 'localhost' : cfg.server.host}:${cfg.server.port}`;
  const url = `${base}/i/${inv!.token}`;
  const headline = countAdmins() === 0
    ? 'No admin account yet — open this link to create the first one:'
    : 'Reusable admin bootstrap link (each redeem mints a new admin):';

  console.log('\n' + '='.repeat(72));
  console.log(`  ${headline}`);
  console.log(`  ${url}`);
  console.log('='.repeat(72) + '\n');
}

syncBots();
console.log('[init] bots synced');

await initHoncho();

configManager.watch();
configManager.onChange(() => {
  syncBots();
  console.log('[config] bots re-synced');
});

// Setup MessageBus
messageBus.register(webChannel);
messageBus.register(iosChannel);
messageBus.setMessageHandler(({ conversationId, botId, userId, content, attachmentIds, metadata, replyFn }) => {
  // Signal any running generation to stop after 2s grace period
  signalNewMessage(conversationId);

  // Handle /surf command — creates a 冲浪 tab conversation pinned to the
  // current message conv, runs the surf, and delivers the final message back
  // into this chat (preserves the "bot proactively shares" UX). The full run
  // record lives in the new surf conv for inspection.
  if (content === '/surf') {
    try {
      const surfConvId = createSurfConversation({
        botId, userId,
        sourceMessageConvId: conversationId,
        costBudgetUsd: configManager.getBotConfig(botId).surfing.costBudgetUsd,
      });
      runSurf({ surfConvId, sourceConvId: conversationId, replyFn, trigger: 'user' })
        .catch(e => {
          console.error('[surf] error:', e);
          replyFn({ type: 'error', conversationId, content: '冲浪出了点问题 稍后再试' });
        });
    } catch (e) {
      console.error('[surf] launch error:', e);
      replyFn({ type: 'error', conversationId, content: '冲浪没起来 稍后再试' });
    }
    return;
  }

  // Cancel any pending review timer (new message arrived)
  cancelPendingReview(conversationId);

  // Per-message tone choice from clients that support it. Telegram/Feishu
  // omit metadata and fall through to the default ('wechat') in buildPrompt.
  const toneRaw = metadata && typeof metadata.tone === 'string' ? metadata.tone : undefined;
  const tone = toneRaw === 'normal' || toneRaw === 'wechat' ? toneRaw : undefined;

  // Pass through debounce. Each entry the user sent becomes its own DB row —
  // only at LLM-request time do consecutive user rows get joined with \n\n.
  debounceAdd(conversationId, botId, userId, content, attachmentIds, replyFn, (entries) => {
    handleUserMessage({
      conversationId, botId, userId,
      userMessages: entries,
      tone,
      replyFn,
    }).catch(e => {
      console.error('[orchestrator] error:', e);
      replyFn({ type: 'error', conversationId, content: '出了点问题 稍后再试' });
    });
  });
});

// Start surfing scheduler
startSurfingScheduler();

// Start orphan-attachment sweeper (deletes uploads that were never bound
// to a message after 15min, every 10min).
startOrphanSweeper();

// --- Platform channels (one Telegram/Feishu account per bot) ---
const envSuffix = (botId: string) => botId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const telegramChannels: import('./bus/channels/telegram').TelegramChannel[] = [];
const feishuChannels: import('./bus/channels/feishu').FeishuChannel[] = [];

for (const [botId, botCfg] of Object.entries(configManager.get().bots)) {
  const tg = botCfg.telegram;
  if (tg?.enabled) {
    const token = tg.token || process.env[`TELEGRAM_TOKEN_${envSuffix(botId)}`] || '';
    if (!token) {
      console.warn(`[init] telegram(${botId}): no token (config or TELEGRAM_TOKEN_${envSuffix(botId)}), skipping`);
    } else {
      const { TelegramChannel } = await import('./bus/channels/telegram');
      const ch = new TelegramChannel({ botId, token, webhookUrl: tg.webhookUrl });
      messageBus.register(ch);
      telegramChannels.push(ch);
      console.log(`[init] telegram(${botId}) registered`);
    }
  }

  const fs = botCfg.feishu;
  if (fs?.enabled) {
    const appId = fs.appId || process.env[`FEISHU_APP_ID_${envSuffix(botId)}`] || '';
    const appSecret = fs.appSecret || process.env[`FEISHU_APP_SECRET_${envSuffix(botId)}`] || '';
    if (!appId || !appSecret) {
      console.warn(`[init] feishu(${botId}): missing creds (config or FEISHU_APP_ID_${envSuffix(botId)} / FEISHU_APP_SECRET_${envSuffix(botId)}), skipping`);
    } else {
      const { FeishuChannel } = await import('./bus/channels/feishu');
      const ch = new FeishuChannel({
        botId, appId, appSecret,
        verificationToken: fs.verificationToken,
      });
      messageBus.register(ch);
      feishuChannels.push(ch);
      await ch.start();
      console.log(`[init] feishu(${botId}) ready`);
    }
  }
}

// Hono app
const app = new Hono();

// Surface HTTPException thrown from API helpers as `{ error: msg }` JSON,
// matching the explicit `c.json({ error }, code)` shape every other route uses.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('[api] uncaught:', err);
  return c.json({ error: 'internal server error' }, 500);
});

// API routes
// Auth runs before every /api route. Resolves the caller from either the
// Authorization: Bearer header (iOS / programmatic) or the pb_session
// cookie (web), then stashes the user on the context. Onboarding endpoints
// (invite redeem) and /api/health are whitelisted inside the middleware.
app.use('/api/*', apiKeyAuthMiddleware);

app.route('/api', apiRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api', chatApiRoutes);
app.route('/api/surf', surfRoutes);
app.route('/api/review', reviewRoutes);
app.route('/api/debate', debateRoutes);
app.route('/api/portrait', portraitRoutes);
app.route('/api/me', meRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/openrouter', openrouterRoutes);
app.route('/api/mobile', mobileApiRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/keys', keysRoutes);
app.route('/api/invites', invitesRoutes);
app.route('/api/admin', adminRoutes);

// Logout — clear the session cookie. The api key itself stays valid (so
// existing iOS sessions don't blow up if the same user logs out of the web
// UI); we just stop telling browsers about it.
app.post('/api/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// Share-link landing + redeem + AASA. Mounted at root so paths like /i/<token>
// and /.well-known/apple-app-site-association resolve as expected.
app.route('/', connectRoutes);

// Serve uploaded attachments. URL is /uploads/<attachment-id>. Requires the
// caller to own the conversation the attachment is bound to (resolved via
// the same pb_session cookie or Bearer key the API uses). Orphan attachments
// — message_id and conversation_id both null — are visible to any logged-in
// user since there's no owner yet (they're typically just-uploaded blobs
// the same user is about to bind to a message).
app.get('/uploads/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await getAttachmentForServing(id);
  if (!entry) return c.text('not found', 404);

  const auth = c.req.header('authorization');
  let viewer = auth ? resolveApiKeyAuth(auth) : null;
  if (!viewer) {
    const cookieHeader = c.req.header('cookie') ?? '';
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== 'pb_session') continue;
      const k = decodeURIComponent(part.slice(eq + 1).trim());
      const row = findApiKeyByHash(hashApiKey(k));
      if (!row || row.revoked_at) break;
      const u = findUserById(row.user_id);
      if (u) viewer = { user: u as any, apiKey: row };
      break;
    }
  }
  if (!viewer) return c.text('not authenticated', 401);

  if (entry.row.conversation_id) {
    const conv = findConversationById(entry.row.conversation_id);
    if (!conv || conv.user_id !== viewer.user.id) return c.text('not found', 404);
  }

  const file = Bun.file(entry.absPath);
  return new Response(file, {
    headers: {
      'Content-Type': entry.row.mime,
      'Content-Length': String(entry.size),
      // Attachment ids are immutable + unguessable, so cache aggressively.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Platform webhooks (one route per bot)
for (const ch of telegramChannels) {
  if (!ch.webhookUrl) continue; // polling mode doesn't need a route
  app.post(`/webhook/telegram/${ch.botId}`, async (c) => {
    ch.handleUpdate(await c.req.json());
    return c.json({ ok: true });
  });
}
for (const ch of feishuChannels) {
  app.post(`/webhook/feishu/${ch.botId}`, async (c) => {
    return c.json(await ch.handleEvent(await c.req.json()));
  });
}

// Static files. Resolved relative to this source file (../web/static) so
// the server runs the same whether cwd is `main/` or the parent.
const STATIC_DIR = new URL('./web/static', import.meta.url).pathname;
const STATIC_INDEX = `${STATIC_DIR}/index.html`;
app.use('/*', serveStatic({ root: STATIC_DIR }));

// Fallback to index.html for SPA
app.get('/*', async (c) => {
  const file = Bun.file(STATIC_INDEX);
  return new Response(await file.text(), { headers: { 'Content-Type': 'text/html' } });
});

const port = configManager.get().server.port;

// Shared WS data shape: tag discriminates which channel owns the socket.
type WsData = (WebSocketData & { channel: 'web' }) | (IOSWebSocketData & { channel: 'ios' });

// Bun server with WebSocket
const server = Bun.serve({
  port,
  hostname: configManager.get().server.host,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — web client. Auth is by the same pb_session cookie
    // the REST API uses; same-origin WS requests carry it automatically.
    // We resolve the cookie's api_key here (mirroring the apiKeyAuthMiddleware
    // path) and key the WS connection by the user's external_id so the
    // existing webChannel.send routing keeps working unchanged.
    if (url.pathname === '/ws') {
      const cookieHeader = req.headers.get('cookie') ?? '';
      let sessionKey: string | null = null;
      for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === 'pb_session') {
          sessionKey = decodeURIComponent(part.slice(eq + 1).trim());
          break;
        }
      }
      if (!sessionKey) return new Response('not authenticated', { status: 401 });
      const row = findApiKeyByHash(hashApiKey(sessionKey));
      if (!row || row.revoked_at) return new Response('invalid session', { status: 401 });
      const user = findUserById(row.user_id);
      if (!user) return new Response('user vanished', { status: 401 });
      const externalId = user.external_id ?? user.id;
      const upgraded = server.upgrade(req, { data: { userId: externalId, channel: 'web' } satisfies WsData });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // WebSocket upgrade — iOS mobile client
    //
    // Auth is by api key, passed as ?key=<pbk_…> (WebSocket clients can't
    // easily set custom headers, so query-param is the standard workaround).
    // We resolve the key to the user's external_id and key the WS connection
    // by that — iosChannel.send(externalId, …) then routes correctly without
    // any change to the channel/router code.
    if (url.pathname === '/ws/mobile') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('key required', { status: 401 });
      const auth = resolveApiKeyAuth(`Bearer ${key}`);
      if (!auth) return new Response('invalid api key', { status: 401 });
      const externalId = auth.user.external_id ?? auth.user.id;
      const upgraded = server.upgrade(req, {
        data: { userId: externalId, channel: 'ios' } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Pass to Hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: {
    open(ws: import('bun').ServerWebSocket<WsData>) {
      if (ws.data.channel === 'ios') iosChannel.addConnection(ws.data.userId, ws as any);
      else webChannel.addConnection(ws.data.userId, ws as any);
    },
    message(ws: import('bun').ServerWebSocket<WsData>, msg) {
      const raw = typeof msg === 'string' ? msg : msg.toString();
      if (ws.data.channel === 'ios') iosChannel.handleMessage(ws.data.userId, raw);
      else webChannel.handleMessage(ws.data.userId, raw);
    },
    close(ws: import('bun').ServerWebSocket<WsData>) {
      if (ws.data.channel === 'ios') iosChannel.removeConnection(ws.data.userId, ws as any);
      else webChannel.removeConnection(ws.data.userId, ws as any);
    },
  },
});

console.log(`[server] BubbleBored running at http://localhost:${port}`);

// Start Telegram channels after server is up
for (const ch of telegramChannels) {
  ch.start().catch(e => console.error(`[${ch.name}] start error:`, e));
}
