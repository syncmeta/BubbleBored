import { Hono } from 'hono';
import { configManager } from '../config/loader';
import {
  listBots, listConversationsByBot, findConversationById,
  getMessages, countMessages,
} from '../db/queries';
import { reviewEvents, checkAndTriggerReview, getPendingReviews } from '../core/review';
import { messageBus } from '../bus/router';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';

export const reviewRoutes = new Hono();

// List bots with review config + all their conversations (each independently reviewable)
reviewRoutes.get('/bots', (c) => {
  const bots = listBots();
  const pending = new Set(getPendingReviews());

  const result = bots.map(b => {
    let review: any = null;
    try {
      review = configManager.getBotConfig(b.id).review;
    } catch {}

    const conversations = listConversationsByBot(b.id, 'message').map(conv => ({
      id: conv.id,
      title: conv.title,
      user_name: conv.user_name,
      last_activity_at: conv.last_activity_at,
      round_count: conv.round_count ?? 0,
      msg_count: countMessages(conv.id),
      has_pending: pending.has(conv.id),
    }));

    return {
      id: b.id,
      display_name: b.display_name,
      review,
      conversations,
    };
  });
  return c.json(result);
});

// Manually trigger review for a specific conversation (manual = skip round check)
reviewRoutes.post('/trigger/:conversationId', async (c) => {
  const conversationId = c.req.param('conversationId');

  const conv = findConversationById(conversationId);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  if (countMessages(conv.id) < 2) {
    return c.json({ error: 'not enough messages to review (need at least 2)' }, 400);
  }

  // Deliver to the conversation (bus's live replyFn, fallback to web channel
  // owner) AND mirror every outbound to the review SSE stream so the panel
  // still sees what got sent.
  const deliver: (msg: OutboundMessage) => void =
    messageBus.getReplyFn(conv.id) ??
    ((msg) => { webChannel.send(conv.user_id, msg).catch(() => {}); });
  const replyFn = (msg: OutboundMessage) => {
    deliver(msg);
    reviewEvents.emit('log', { botId: conv.bot_id, conversationId: conv.id, content: `[reply] ${msg.content}`, timestamp: Date.now() });
  };

  checkAndTriggerReview(conv.id, conv.bot_id, replyFn, true).catch(e => {
    console.error(`[review-api] error:`, e);
    reviewEvents.emit('log', { botId: conv.bot_id, conversationId: conv.id, content: `Error: ${e.message}`, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id, botId: conv.bot_id });
});

// Get messages for a specific conversation (preview)
reviewRoutes.get('/messages/:conversationId', (c) => {
  const conversationId = c.req.param('conversationId');
  const conv = findConversationById(conversationId);
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
