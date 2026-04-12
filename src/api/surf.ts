import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { configManager } from '../config/loader';
import { listBots, findConversation, createConversation, findUserByChannel, createUser } from '../db/queries';
import { surfEvents, activeSurfs, stopSurf, runSurf } from '../core/surfing/searcher';
import type { OutboundMessage } from '../bus/types';

export const surfRoutes = new Hono();

// Ensure a "monitor" user exists for test surfing
function ensureMonitorUser(): string {
  let user = findUserByChannel('web', 'surf-monitor');
  if (!user) {
    const id = randomUUID();
    createUser(id, 'web', 'surf-monitor', 'Surf Monitor');
    user = findUserByChannel('web', 'surf-monitor');
  }
  return user!.id;
}

// List bots with surf config
surfRoutes.get('/bots', (c) => {
  const bots = listBots();
  const result = bots.map(b => {
    try {
      const config = configManager.getBotConfig(b.id);
      return {
        id: b.id,
        display_name: b.display_name,
        surfing: config.surfing,
        active: activeSurfs.has(b.id),
      };
    } catch {
      return { id: b.id, display_name: b.display_name, surfing: null, active: false };
    }
  });
  return c.json(result);
});

// Start surf for a bot
surfRoutes.post('/start/:botId', async (c) => {
  const botId = c.req.param('botId');

  if (activeSurfs.has(botId)) {
    return c.json({ error: 'already running' }, 409);
  }

  const userId = ensureMonitorUser();

  let conv = findConversation(botId, userId);
  if (!conv) {
    const convId = randomUUID();
    createConversation(convId, botId, userId);
    conv = findConversation(botId, userId);
  }
  if (!conv) return c.json({ error: 'cannot create conversation' }, 500);

  const controller = new AbortController();
  activeSurfs.set(botId, controller);

  // No-op replyFn — surf monitor page uses SSE events instead
  const replyFn = (_msg: OutboundMessage) => {};

  // Run in background
  runSurf(conv.id, botId, userId, replyFn, controller.signal).catch(e => {
    console.error(`[surf-api] error:`, e);
    activeSurfs.delete(botId);
    surfEvents.emit('log', { botId, conversationId: conv.id, type: 'surf_status', content: `冲浪出错: ${e.message}`, timestamp: Date.now() });
    surfEvents.emit('done', { botId, conversationId: conv.id, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id });
});

// Stop surf for a bot
surfRoutes.post('/stop/:botId', (c) => {
  const botId = c.req.param('botId');
  const stopped = stopSurf(botId);
  return c.json({ ok: stopped });
});

// Active surfs
surfRoutes.get('/active', (c) => {
  const active = Array.from(activeSurfs.keys());
  return c.json(active);
});

// SSE endpoint for real-time events
surfRoutes.get('/events', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: any) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      const onLog = (data: any) => send('log', data);
      const onDone = (data: any) => send('done', data);

      surfEvents.on('log', onLog);
      surfEvents.on('done', onDone);

      // Send initial active state
      send('init', { active: Array.from(activeSurfs.keys()) });

      // Cleanup when client disconnects
      c.req.raw.signal.addEventListener('abort', () => {
        surfEvents.off('log', onLog);
        surfEvents.off('done', onDone);
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
});
