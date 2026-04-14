import { Hono } from 'hono';
import { configManager } from '../config/loader';
import {
  listBots, findLatestConversationByBot,
  getMessages,
} from '../db/queries';
import { reviewEvents, checkAndTriggerReview, getPendingReviews } from '../core/review';
import type { OutboundMessage } from '../bus/types';

export const reviewRoutes = new Hono();

// List bots with review config and conversation state
reviewRoutes.get('/bots', (c) => {
  const bots = listBots();

  const result = bots.map(b => {
    try {
      const config = configManager.getBotConfig(b.id);
      const conv = findLatestConversationByBot(b.id);
      let msgCount = 0;
      let roundCount = 0;
      if (conv) {
        const msgs = getMessages(conv.id, 999);
        msgCount = msgs.length;
        roundCount = conv.round_count ?? 0;
      }
      return {
        id: b.id,
        display_name: b.display_name,
        review: config.review,
        roundCount,
        msgCount,
        hasPending: conv ? getPendingReviews().includes(conv.id) : false,
      };
    } catch {
      return { id: b.id, display_name: b.display_name, review: null, roundCount: 0, msgCount: 0, hasPending: false };
    }
  });
  return c.json(result);
});

// Manually trigger review for a bot (targets latest active conversation)
reviewRoutes.post('/trigger/:botId', async (c) => {
  const botId = c.req.param('botId');

  const conv = findLatestConversationByBot(botId);
  if (!conv) return c.json({ error: 'no conversation found for this bot' }, 404);

  const msgs = getMessages(conv.id, 999);
  if (msgs.length < 2) {
    return c.json({ error: 'not enough messages to review (need at least 2)' }, 400);
  }

  // No-op replyFn — review monitor page uses SSE
  const replyFn = (msg: OutboundMessage) => {
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `[reply] ${msg.content}`, timestamp: Date.now() });
  };

  // Run review in background (manual = skip round check)
  checkAndTriggerReview(conv.id, botId, replyFn, true).catch(e => {
    console.error(`[review-api] error:`, e);
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `Error: ${e.message}`, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id });
});

// Force-trigger review (manual, skips round check) — same behavior as /trigger now
reviewRoutes.post('/force/:botId', async (c) => {
  const botId = c.req.param('botId');

  const conv = findLatestConversationByBot(botId);
  if (!conv) return c.json({ error: 'no conversation found for this bot' }, 404);

  const msgs = getMessages(conv.id, 999);
  if (msgs.length < 2) {
    return c.json({ error: 'not enough messages to review (need at least 2)' }, 400);
  }

  const replyFn = (msg: OutboundMessage) => {
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `[reply] ${msg.content}`, timestamp: Date.now() });
  };

  checkAndTriggerReview(conv.id, botId, replyFn, true).catch(e => {
    console.error(`[review-api] error:`, e);
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `Error: ${e.message}`, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id });
});

// Get conversation messages (for preview)
reviewRoutes.get('/messages/:botId', (c) => {
  const botId = c.req.param('botId');
  const conv = findLatestConversationByBot(botId);
  if (!conv) return c.json([]);
  const msgs = getMessages(conv.id, 50);
  return c.json(msgs);
});

// SSE endpoint
reviewRoutes.get('/events', (c) => {
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

      reviewEvents.on('log', onLog);
      reviewEvents.on('done', onDone);

      send('init', { pending: getPendingReviews() });

      c.req.raw.signal.addEventListener('abort', () => {
        reviewEvents.off('log', onLog);
        reviewEvents.off('done', onDone);
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
