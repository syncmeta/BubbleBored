import { Hono } from 'hono';
import { configManager } from '../config/loader';
import {
  findUserByChannel, createUser, findUserById, listBots,
  findConversationById, deleteConversation,
  listConversationsByUser, getMessages,
  getSurfRun,
} from '../db/queries';
import {
  surfEvents, activeSurfs, surfsByMessageConv,
  stopSurf, runSurf, createSurfConversation,
} from '../core/surfing/searcher';
import { modelFor } from '../core/models';
import { messageBus } from '../bus/router';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';
import { randomUUID } from 'crypto';

export const surfRoutes = new Hono();

// Resolve the right reply path for a (surf or message) conversation.
function makeReplyFn(conv: { id: string; user_id: string }) {
  const bound = messageBus.getReplyFn(conv.id);
  if (bound) return bound;
  const user = findUserById(conv.user_id);
  const externalId = user?.external_id ?? null;
  return (msg: OutboundMessage) => {
    if (externalId) webChannel.send(externalId, msg).catch(() => {});
  };
}

// ── 冲浪 tab list ──

// Lists 冲浪 tab conversations for the user, hydrated with the run record.
surfRoutes.get('/conversations', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, 'surf');
  const out = convs.map((conv: any) => {
    const run = getSurfRun(conv.id);
    return {
      ...conv,
      model_slug: run?.model_slug ?? null,
      source_message_conv_id: run?.source_message_conv_id ?? null,
      status: run?.status ?? 'unknown',
      budget: run?.budget ?? null,
      active: activeSurfs.has(conv.id),
    };
  });
  return c.json(out);
});

surfRoutes.get('/conversations/:id', (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.feature_type !== 'surf') return c.json({ error: 'not a surf conv' }, 400);
  const run = getSurfRun(id);
  return c.json({
    ...conv,
    model_slug: run?.model_slug ?? null,
    source_message_conv_id: run?.source_message_conv_id ?? null,
    status: run?.status ?? 'unknown',
    budget: run?.budget ?? null,
    active: activeSurfs.has(id),
  });
});

// All persisted log + result messages for a surf run, in chronological order.
surfRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  const msgs = getMessages(id, 500);
  return c.json(msgs);
});

surfRoutes.delete('/conversations/:id', (c) => {
  const id = c.req.param('id');
  // Stop any in-flight run before tearing down the conv.
  stopSurf(id);
  deleteConversation(id);
  return c.json({ ok: true });
});

// ── Create + run ──

// Creates a new 冲浪 tab conversation and immediately starts the run.
// `sourceMessageConversationId` is optional: when given, the planner pulls
// context from that message conv and the final curator message is also
// delivered there as a bot message.
surfRoutes.post('/conversations', async (c) => {
  const body = await c.req.json<{
    userId: string;
    botId?: string;
    sourceMessageConversationId?: string;
    modelSlug?: string;
    budget?: number;
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

  // Resolve the bot — prefer the explicit one, else inherit from the source
  // message conv, else fall back to the first registered bot. Surf runs
  // technically need a bot only for FK satisfaction.
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

  const modelSlug = body.modelSlug?.trim() || modelFor('surfing');
  const budget = body.budget && body.budget > 0
    ? body.budget
    : configManager.getBotConfig(botId).surfing.maxRequests;

  const surfConvId = createSurfConversation({
    botId, userId: user.id,
    sourceMessageConvId: sourceConvId,
    modelSlug, budget,
    title: body.title ?? null,
  });

  const surfConv = findConversationById(surfConvId);
  if (!surfConv) return c.json({ error: 'create failed' }, 500);

  if (body.autoStart !== false) {
    const replyFn = makeReplyFn({ id: surfConvId, user_id: user.id });
    const controller = new AbortController();
    activeSurfs.set(surfConvId, controller);
    if (sourceConvId) surfsByMessageConv.set(sourceConvId, surfConvId);
    runSurf({ surfConvId, sourceConvId, replyFn, signal: controller.signal, trigger: 'panel' })
      .catch(e => console.error('[surf-api] error:', e));
  }

  return c.json({
    id: surfConvId,
    botId,
    sourceMessageConversationId: sourceConvId,
    modelSlug,
    budget,
  });
});

// Re-run an existing surf conversation. Useful when the user wants to refresh
// the same (source, model) combo without creating a new history.
surfRoutes.post('/run/:id', async (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.feature_type !== 'surf') return c.json({ error: 'not a surf conv' }, 400);
  if (activeSurfs.has(id)) return c.json({ error: 'already running' }, 409);

  const run = getSurfRun(id);
  if (!run) return c.json({ error: 'run record missing' }, 500);

  const replyFn = makeReplyFn(conv);
  const controller = new AbortController();
  activeSurfs.set(id, controller);
  if (run.source_message_conv_id) surfsByMessageConv.set(run.source_message_conv_id, id);

  runSurf({
    surfConvId: id,
    sourceConvId: run.source_message_conv_id ?? null,
    replyFn, signal: controller.signal, trigger: 'panel',
  }).catch(e => console.error('[surf-api] error:', e));

  return c.json({ ok: true });
});

surfRoutes.post('/stop/:id', (c) => {
  const id = c.req.param('id');
  const stopped = stopSurf(id);
  return c.json({ ok: stopped });
});

surfRoutes.get('/active', (c) => {
  return c.json(Array.from(activeSurfs.keys()));
});

// Source message conversations the user can pin a surf to.
surfRoutes.get('/sources', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  return c.json(listConversationsByUser(user.id, 'message'));
});

// SSE for live log lines (every emit() in searcher.ts streams here).
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
      // Active surf conv ids + the message convs they're bound to. The
      // chat-header surf button uses sources to know when to show busy.
      send('init', {
        active: Array.from(activeSurfs.keys()),
        sources: Array.from(surfsByMessageConv.keys()),
      });
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
