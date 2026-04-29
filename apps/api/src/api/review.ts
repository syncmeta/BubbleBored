import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  findConversationById, deleteConversation,
  listConversationsByUser, getMessages, insertMessage,
  getReviewRun,
} from '../db/queries';
import {
  reviewEvents, checkAndTriggerReview,
  createReviewConversation, runReview, continueReview,
  reviewsByMessageConv, getPendingReviews,
} from '../core/review';
import {
  makeReplyFn, getOrCreateUser, findUser, resolveBotId,
  sseStream, assertFeatureType,
} from './_helpers';

export const reviewRoutes = new Hono();

// ── 回顾 tab list ──

reviewRoutes.get('/conversations', (c) => {
  const user = findUser(c);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, 'review');
  const pending = new Set(getPendingReviews());
  const out = convs.map((conv: any) => {
    const run = getReviewRun(conv.id);
    return {
      ...conv,
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
  assertFeatureType(conv, 'review');
  const run = getReviewRun(id);
  return c.json({
    ...conv,
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
    botId?: string;
    sourceMessageConversationId?: string;
    title?: string;
    autoStart?: boolean;
  }>();

  const user = getOrCreateUser(c);

  let sourceConvId: string | null = null;
  if (body.sourceMessageConversationId) {
    const src = findConversationById(body.sourceMessageConversationId);
    if (!src) return c.json({ error: 'source conversation not found' }, 404);
    assertFeatureType(src, 'message');
    sourceConvId = src.id;
  }

  const botId = resolveBotId({
    explicit: body.botId,
    fromSourceConvId: sourceConvId,
  });

  const reviewConvId = createReviewConversation({
    botId, userId: user.id,
    sourceMessageConvId: sourceConvId,
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
  });
});

// Re-run an existing review conversation.
reviewRoutes.post('/run/:id', async (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'review');
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
  const user = findUser(c);
  if (!user) return c.json([]);
  const botId = c.req.query('botId');
  const all = listConversationsByUser(user.id, 'message');
  return c.json(botId ? all.filter((c: any) => c.bot_id === botId) : all);
});

// In-message trigger from the chat-header review button. Creates a 回顾
// tab conv pinned to the message conv as source.
reviewRoutes.post('/trigger/:messageConvId', async (c) => {
  const id = c.req.param('messageConvId');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  assertFeatureType(conv, 'message');

  const replyFn = makeReplyFn(conv);
  checkAndTriggerReview(id, conv.bot_id, replyFn, true).catch(e => {
    console.error('[review-api] error:', e);
  });

  return c.json({ ok: true });
});

// Follow-up message: user replies inside the review conv after the first-pass
// self-review. Stores the user's message, then kicks off continueReview() to
// generate the bot's next turn (free-form chat, no structured tags).
reviewRoutes.post('/conversations/:id/message', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ content?: string }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content required' }, 400);

  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'review');

  const userMsgId = randomUUID();
  insertMessage(userMsgId, id, 'user', conv.user_id, content);

  continueReview({ reviewConvId: id, userText: content })
    .catch(e => console.error('[review-api] followup error:', e));

  return c.json({ ok: true, messageId: userMsgId });
});

// SSE
reviewRoutes.get('/events', (c) => sseStream(reviewEvents, c.req.raw.signal, () => ({
  pending: getPendingReviews(),
  sources: Array.from(reviewsByMessageConv.keys()),
})));

// Re-run + live-stream events for a single review conversation. iOS uses this
// for the "继续" / refresh button: the response is an SSE stream of just the
// log/done events for THIS reviewConvId. The web client uses the global
// /events stream and doesn't need this scoped variant, but it works there too.
reviewRoutes.post('/conversations/:id/continue', async (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'review');
  const run = getReviewRun(id);
  if (!run) return c.json({ error: 'run record missing' }, 500);

  if (run.source_message_conv_id) {
    reviewsByMessageConv.set(run.source_message_conv_id, id);
  }
  const replyFn = makeReplyFn(conv);

  // Kick off the run in the background. Events go through the same global
  // emitter the SSE stream listens to.
  runReview({
    reviewConvId: id,
    sourceConvId: run.source_message_conv_id ?? null,
    replyFn, trigger: 'panel',
  }).catch(e => console.error('[review-api] continue error:', e));

  // Stream a filtered view of the global emitter, ending the stream when a
  // matching `done` event fires for this id.
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      const close = () => {
        if (closed) return;
        closed = true;
        reviewEvents.off('log', onLog);
        reviewEvents.off('done', onDone);
        try { controller.close(); } catch {}
      };
      const onLog = (data: any) => {
        if (data?.reviewConvId !== id) return;
        send('log', data);
      };
      const onDone = (data: any) => {
        if (data?.reviewConvId !== id) return;
        send('done', data);
        // Give the client a beat to consume the done frame, then end.
        setTimeout(close, 50);
      };
      reviewEvents.on('log', onLog);
      reviewEvents.on('done', onDone);
      send('init', { reviewConvId: id });
      c.req.raw.signal.addEventListener('abort', close);
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
