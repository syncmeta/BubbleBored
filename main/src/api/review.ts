import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { configManager } from '../config/loader';
import {
  findUserByChannel, createUser, findUserById, listBots,
  findConversationById, deleteConversation,
  listConversationsByUser, getMessages,
  getReviewRun,
} from '../db/queries';
import {
  reviewEvents, checkAndTriggerReview,
  createReviewConversation, runReview,
  reviewsByMessageConv, getPendingReviews,
} from '../core/review';
import { modelFor } from '../core/models';
import { messageBus } from '../bus/router';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';

export const reviewRoutes = new Hono();

function makeReplyFn(conv: { id: string; user_id: string }) {
  const bound = messageBus.getReplyFn(conv.id);
  if (bound) return bound;
  const user = findUserById(conv.user_id);
  const externalId = user?.external_id ?? null;
  return (msg: OutboundMessage) => {
    if (externalId) webChannel.send(externalId, msg).catch(() => {});
  };
}

// ── 回顾 tab list ──

reviewRoutes.get('/conversations', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, 'review');
  const pending = new Set(getPendingReviews());
  const out = convs.map((conv: any) => {
    const run = getReviewRun(conv.id);
    return {
      ...conv,
      model_slug: run?.model_slug ?? null,
      source_message_conv_id: run?.source_message_conv_id ?? null,
      status: run?.status ?? 'unknown',
      has_pending: pending.has(conv.id),
    };
  });
  return c.json(out);
});

reviewRoutes.get('/conversations/:id', (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.feature_type !== 'review') return c.json({ error: 'not a review conv' }, 400);
  const run = getReviewRun(id);
  return c.json({
    ...conv,
    model_slug: run?.model_slug ?? null,
    source_message_conv_id: run?.source_message_conv_id ?? null,
    status: run?.status ?? 'unknown',
  });
});

reviewRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  return c.json(getMessages(id, 500));
});

reviewRoutes.delete('/conversations/:id', (c) => {
  deleteConversation(c.req.param('id'));
  return c.json({ ok: true });
});

// ── Create + run ──

reviewRoutes.post('/conversations', async (c) => {
  const body = await c.req.json<{
    userId: string;
    botId?: string;
    sourceMessageConversationId?: string;
    modelSlug?: string;
    title?: string;
    autoStart?: boolean;
  }>();
  if (!body.userId) return c.json({ error: 'userId required' }, 400);

  let user = findUserByChannel('web', body.userId);
  if (!user) {
    const newId = randomUUID();
    createUser(newId, 'web', body.userId, `User-${body.userId.slice(0, 6)}`);
    user = findUserByChannel('web', body.userId);
  }
  if (!user) return c.json({ error: 'user creation failed' }, 500);

  let botId = body.botId;
  let sourceConvId: string | null = null;
  if (body.sourceMessageConversationId) {
    const src = findConversationById(body.sourceMessageConversationId);
    if (!src) return c.json({ error: 'source conversation not found' }, 404);
    if (src.feature_type !== 'message') {
      return c.json({ error: 'source must be a message conversation' }, 400);
    }
    sourceConvId = src.id;
    if (!botId) botId = src.bot_id;
  }
  if (!botId) {
    const bots = listBots();
    if (bots.length === 0) return c.json({ error: 'no bots configured' }, 500);
    botId = bots[0].id as string;
  }

  const modelSlug = body.modelSlug?.trim() || modelFor('review');

  const reviewConvId = createReviewConversation({
    botId, userId: user.id,
    sourceMessageConvId: sourceConvId,
    modelSlug,
    title: body.title ?? null,
  });

  if (body.autoStart !== false) {
    if (sourceConvId) reviewsByMessageConv.set(sourceConvId, reviewConvId);
    const reviewConv = findConversationById(reviewConvId);
    if (reviewConv) {
      const replyFn = makeReplyFn(reviewConv);
      runReview({
        reviewConvId,
        sourceConvId,
        replyFn,
        trigger: 'panel',
      }).catch(e => console.error('[review-api] error:', e));
    }
  }

  return c.json({
    id: reviewConvId, botId,
    sourceMessageConversationId: sourceConvId,
    modelSlug,
  });
});

// Re-run an existing review conversation.
reviewRoutes.post('/run/:id', async (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.feature_type !== 'review') return c.json({ error: 'not a review conv' }, 400);
  const run = getReviewRun(id);
  if (!run) return c.json({ error: 'run record missing' }, 500);

  if (run.source_message_conv_id) {
    reviewsByMessageConv.set(run.source_message_conv_id, id);
  }
  const replyFn = makeReplyFn(conv);
  runReview({
    reviewConvId: id,
    sourceConvId: run.source_message_conv_id ?? null,
    replyFn, trigger: 'panel',
  }).catch(e => console.error('[review-api] error:', e));

  return c.json({ ok: true });
});

reviewRoutes.get('/sources', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  return c.json(listConversationsByUser(user.id, 'message'));
});

// In-message trigger from the chat-header review button. Creates a 回顾
// tab conv pinned to the message conv as source.
reviewRoutes.post('/trigger/:messageConvId', async (c) => {
  const id = c.req.param('messageConvId');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  if (conv.feature_type !== 'message') {
    return c.json({ error: 'must be a message conv' }, 400);
  }

  const replyFn = makeReplyFn(conv);
  checkAndTriggerReview(id, conv.bot_id, replyFn, true).catch(e => {
    console.error('[review-api] error:', e);
  });

  return c.json({ ok: true });
});

// SSE
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
      send('init', {
        pending: getPendingReviews(),
        sources: Array.from(reviewsByMessageConv.keys()),
      });
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
