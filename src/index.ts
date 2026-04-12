import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { configManager } from './config/loader';
import { getDb } from './db/index';
import { syncBots } from './bots/registry';
import { messageBus } from './bus/router';
import { webChannel } from './bus/channels/web';
import type { WebSocketData } from './bus/channels/web';
import { apiRoutes } from './api/routes';
import { auditRoutes } from './api/audit';
import { chatApiRoutes } from './api/bots';
import { addMessage as debounceAdd, cancelPending } from './core/debounce';
import { handleUserMessage } from './core/orchestrator';
import { cancelPendingReview } from './core/review';
import { startSurfingScheduler } from './core/surfing/trigger';
import type { OutboundMessage } from './bus/types';

// Initialize
await configManager.load();
console.log('[init] config loaded');

getDb();
console.log('[init] database ready');

syncBots();
console.log('[init] bots synced');

configManager.watch();
configManager.onChange(() => {
  syncBots();
  console.log('[config] bots re-synced');
});

// Setup MessageBus
messageBus.register(webChannel);
messageBus.setMessageHandler(({ conversationId, botId, userId, content, replyFn }) => {
  // Handle /surf command
  if (content === '/surf') {
    import('./core/surfing/searcher').then(({ runSurf }) => {
      runSurf(conversationId, botId, userId, replyFn).catch(e =>
        console.error('[surf] error:', e)
      );
    });
    return;
  }

  // Cancel any pending review timer (new message arrived)
  cancelPendingReview(conversationId);

  // Pass through debounce
  debounceAdd(conversationId, botId, userId, content, replyFn, (mergedContent) => {
    handleUserMessage({ conversationId, botId, userId, mergedContent, replyFn }).catch(e => {
      console.error('[orchestrator] error:', e);
      replyFn({ type: 'error', conversationId, content: '出了点问题 稍后再试' });
    });
  });
});

// Start surfing scheduler
startSurfingScheduler();

// Hono app
const app = new Hono();

// API routes
app.route('/api', apiRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api', chatApiRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Static files
app.use('/*', serveStatic({ root: './src/web/static' }));

// Fallback to index.html for SPA
app.get('/*', async (c) => {
  const file = Bun.file('./src/web/static/index.html');
  return new Response(await file.text(), { headers: { 'Content-Type': 'text/html' } });
});

const port = configManager.get().server.port;

// Bun server with WebSocket
const server = Bun.serve({
  port,
  hostname: configManager.get().server.host,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const userId = url.searchParams.get('userId');
      if (!userId) {
        return new Response('userId required', { status: 400 });
      }
      const upgraded = server.upgrade(req, { data: { userId } as WebSocketData });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Pass to Hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: {
    open(ws: import('bun').ServerWebSocket<WebSocketData>) {
      webChannel.addConnection(ws.data.userId, ws);
    },
    message(ws: import('bun').ServerWebSocket<WebSocketData>, msg) {
      webChannel.handleMessage(ws.data.userId, typeof msg === 'string' ? msg : msg.toString());
    },
    close(ws: import('bun').ServerWebSocket<WebSocketData>) {
      webChannel.removeConnection(ws.data.userId, ws);
    },
  },
});

console.log(`[server] BeyondBubble running at http://localhost:${port}`);
