import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
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
import { mobileApiRoutes } from './api/mobile';
import { uploadRoutes } from './api/upload';
import { addMessage as debounceAdd } from './core/debounce';
import { handleUserMessage, signalNewMessage } from './core/orchestrator';
import { cancelPendingReview } from './core/review';
import { startSurfingScheduler } from './core/surfing/trigger';
import { startOrphanSweeper, getAttachmentForServing } from './core/attachments';
import { initHoncho } from './honcho/client';
import { ensureModelAssignmentsSeeded } from './core/models';
import type { OutboundMessage } from './bus/types';

// Initialize
await configManager.load();
console.log('[init] config loaded');

getDb();
console.log('[init] database ready');

ensureModelAssignmentsSeeded();

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
messageBus.setMessageHandler(({ conversationId, botId, userId, content, attachmentIds, replyFn }) => {
  // Signal any running generation to stop after 2s grace period
  signalNewMessage(conversationId);

  // Handle /surf command — creates a 冲浪 tab conversation pinned to the
  // current message conv, runs the surf, and delivers the final message back
  // into this chat (preserves the "bot proactively shares" UX). The full run
  // record lives in the new surf conv for inspection.
  if (content === '/surf') {
    import('./core/surfing/searcher').then(({ runSurf, createSurfConversation }) => {
      import('./core/models').then(({ modelFor }) => {
        const surfConvId = createSurfConversation({
          botId, userId,
          sourceMessageConvId: conversationId,
          modelSlug: modelFor('surfing'),
          budget: configManager.getBotConfig(botId).surfing.maxRequests,
        });
        runSurf({ surfConvId, sourceConvId: conversationId, replyFn, trigger: 'user' })
          .catch(e => console.error('[surf] error:', e));
      });
    });
    return;
  }

  // Cancel any pending review timer (new message arrived)
  cancelPendingReview(conversationId);

  // Pass through debounce. Each entry the user sent becomes its own DB row —
  // only at LLM-request time do consecutive user rows get joined with \n\n.
  debounceAdd(conversationId, botId, userId, content, attachmentIds, replyFn, (entries) => {
    handleUserMessage({
      conversationId, botId, userId,
      userMessages: entries,
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

// API routes
app.route('/api', apiRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api', chatApiRoutes);
app.route('/api/surf', surfRoutes);
app.route('/api/review', reviewRoutes);
app.route('/api/debate', debateRoutes);
app.route('/api/portrait', portraitRoutes);
app.route('/api/me', meRoutes);
app.route('/api/mobile', mobileApiRoutes);
app.route('/api/upload', uploadRoutes);

// Serve uploaded attachments. The URL is /uploads/<attachment-id> — the id
// is looked up in SQLite to resolve the canonical on-disk path. This keeps
// the on-disk layout opaque to clients and lets us migrate storage later.
app.get('/uploads/:id', async (c) => {
  const id = c.req.param('id');
  const entry = await getAttachmentForServing(id);
  if (!entry) return c.text('not found', 404);

  const file = Bun.file(entry.absPath);
  return new Response(file, {
    headers: {
      'Content-Type': entry.row.mime,
      'Content-Length': String(entry.size),
      // Attachment ids are immutable + unguessable, so cache aggressively.
      'Cache-Control': 'public, max-age=31536000, immutable',
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

// Static files
app.use('/*', serveStatic({ root: './src/web/static' }));

// Fallback to index.html for SPA
app.get('/*', async (c) => {
  const file = Bun.file('./src/web/static/index.html');
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

    // WebSocket upgrade — web client
    if (url.pathname === '/ws') {
      const userId = url.searchParams.get('userId');
      if (!userId) return new Response('userId required', { status: 400 });
      const upgraded = server.upgrade(req, { data: { userId, channel: 'web' } satisfies WsData });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // WebSocket upgrade — iOS mobile client
    if (url.pathname === '/ws/mobile') {
      const userId = url.searchParams.get('userId');
      if (!userId) return new Response('userId required', { status: 400 });
      const upgraded = server.upgrade(req, { data: { userId, channel: 'ios' } satisfies WsData });
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
