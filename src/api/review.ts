import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { configManager } from '../config/loader';
import {
  listBots, findConversation, createConversation,
  findUserByChannel, createUser, findConversationById,
  getMessages, updateConversationRound,
} from '../db/queries';
import { reviewEvents, checkAndTriggerReview, getPendingReviews } from '../core/review';
import type { OutboundMessage } from '../bus/types';

export const reviewRoutes = new Hono();

function ensureMonitorUser(): string {
  let user = findUserByChannel('web', 'review-monitor');
  if (!user) {
    const id = randomUUID();
    createUser(id, 'web', 'review-monitor', 'Review Monitor');
    user = findUserByChannel('web', 'review-monitor');
  }
  return user!.id;
}

// List bots with review config and conversation state
reviewRoutes.get('/bots', (c) => {
  const bots = listBots();
  const userId = ensureMonitorUser();

  const result = bots.map(b => {
    try {
      const config = configManager.getBotConfig(b.id);
      const conv = findConversation(b.id, userId);
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

// Manually trigger review for a bot
reviewRoutes.post('/trigger/:botId', async (c) => {
  const botId = c.req.param('botId');
  const userId = ensureMonitorUser();

  let conv = findConversation(botId, userId);
  if (!conv) {
    const convId = randomUUID();
    createConversation(convId, botId, userId);
    conv = findConversation(botId, userId);
  }
  if (!conv) return c.json({ error: 'cannot create conversation' }, 500);

  const msgs = getMessages(conv.id, 999);
  if (msgs.length < 2) {
    return c.json({ error: 'not enough messages to review (need at least 2)' }, 400);
  }

  // No-op replyFn — review monitor page uses SSE
  const replyFn = (msg: OutboundMessage) => {
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `[reply] ${msg.content}`, timestamp: Date.now() });
  };

  // Run review in background
  checkAndTriggerReview(conv.id, botId, replyFn).catch(e => {
    console.error(`[review-api] error:`, e);
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `Error: ${e.message}`, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id });
});

// Force-trigger review: temporarily set round_count to match roundInterval
reviewRoutes.post('/force/:botId', async (c) => {
  const botId = c.req.param('botId');
  const userId = ensureMonitorUser();

  let conv = findConversation(botId, userId);
  if (!conv) {
    const convId = randomUUID();
    createConversation(convId, botId, userId);
    conv = findConversation(botId, userId);
  }
  if (!conv) return c.json({ error: 'cannot create conversation' }, 500);

  const msgs = getMessages(conv.id, 999);
  if (msgs.length < 2) {
    return c.json({ error: 'not enough messages to review (need at least 2)' }, 400);
  }

  const botConfig = configManager.getBotConfig(botId);
  // Set round_count to trigger review
  const targetRound = botConfig.review.roundInterval;
  updateConversationRound(conv.id, targetRound, 'bot');

  const replyFn = (msg: OutboundMessage) => {
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `[reply] ${msg.content}`, timestamp: Date.now() });
  };

  checkAndTriggerReview(conv.id, botId, replyFn).catch(e => {
    console.error(`[review-api] error:`, e);
    reviewEvents.emit('log', { botId, conversationId: conv.id, content: `Error: ${e.message}`, timestamp: Date.now() });
  });

  return c.json({ ok: true, conversationId: conv.id, forcedRound: targetRound });
});

// Get conversation messages (for preview)
reviewRoutes.get('/messages/:botId', (c) => {
  const botId = c.req.param('botId');
  const userId = ensureMonitorUser();
  const conv = findConversation(botId, userId);
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
