import { Hono } from 'hono';
import { configManager } from '../config/loader';
import { listBots, listConversationsByBot, findConversationById } from '../db/queries';
import { surfEvents, activeSurfs, stopSurf, runSurf } from '../core/surfing/searcher';
import { messageBus } from '../bus/router';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';

export const surfRoutes = new Hono();

// List bots with their conversations (each conv independently surfable)
surfRoutes.get('/bots', (c) => {
  const bots = listBots();
  const result = bots.map(b => {
    let surfing: any = null;
    try {
      surfing = configManager.getBotConfig(b.id).surfing;
    } catch {}

    const conversations = listConversationsByBot(b.id).map(conv => ({
      id: conv.id,
      title: conv.title,
      user_name: conv.user_name,
      last_activity_at: conv.last_activity_at,
      round_count: conv.round_count ?? 0,
      active: activeSurfs.has(conv.id),
    }));

    return {
      id: b.id,
      display_name: b.display_name,
      surfing,
      conversations,
    };
  });
  return c.json(result);
});

// Start surf for a specific conversation
surfRoutes.post('/start/:conversationId', async (c) => {
  const conversationId = c.req.param('conversationId');

  if (activeSurfs.has(conversationId)) {
    return c.json({ error: 'already running' }, 409);
  }

  const conv = findConversationById(conversationId);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const controller = new AbortController();
  activeSurfs.set(conversationId, controller);

  // Prefer the bus's live replyFn (whichever channel the user last spoke on).
  // Fall back to the web channel addressed by the conversation owner —
  // covers the common case where a web user triggered from the panel
  // without having spoken since reconnecting.
  const replyFn: (msg: OutboundMessage) => void =
    messageBus.getReplyFn(conv.id) ??
    ((msg) => { webChannel.send(conv.user_id, msg).catch(() => {}); });

  runSurf(conv.id, conv.bot_id, conv.user_id, replyFn, controller.signal).catch(e => {
    console.error(`[surf-api] error:`, e);
    activeSurfs.delete(conversationId);
    surfEvents.emit('log', { botId: conv.bot_id, conversationId: conv.id, type: 'surf_status', content: `冲浪出错: ${e.message}`, timestamp: Date.now() });
    surfEvents.emit('done', { botId: conv.bot_id, conversationId: conv.id, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id, botId: conv.bot_id });
});

// Stop surf for a conversation
surfRoutes.post('/stop/:conversationId', (c) => {
  const conversationId = c.req.param('conversationId');
  const stopped = stopSurf(conversationId);
  return c.json({ ok: stopped });
});

// Active surfs (list of conversationIds)
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

      // Send initial active state (conversationIds)
      send('init', { active: Array.from(activeSurfs.keys()) });

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
