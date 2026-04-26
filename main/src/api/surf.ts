import { Hono } from 'hono';
import { configManager } from '../config/loader';
import {
  findConversationById, deleteConversation,
  listConversationsByUser, getMessages,
  getSurfRun,
} from '../db/queries';
import {
  surfEvents, activeSurfs, surfsByMessageConv,
  stopSurf, runSurf, createSurfConversation,
  type VectorOverride,
} from '../core/surfing/searcher';
import { modelFor } from '../core/models';
import {
  makeReplyFn, getOrCreateUser, findUser, resolveBotId,
  sseStream, assertFeatureType,
} from './_helpers';

export const surfRoutes = new Hono();

// ── 冲浪 tab list ──

// Lists 冲浪 tab conversations for the user, hydrated with the run record.
surfRoutes.get('/conversations', (c) => {
  const user = findUser(c);
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
  assertFeatureType(conv, 'surf');
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
    botId?: string;
    sourceMessageConversationId?: string;
    modelSlug?: string;
    budget?: number;
    title?: string;
    autoStart?: boolean;
    vectorOverride?: { topic: string; mode: string; freshness_window?: string };
    forceSerendipity?: boolean;
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

  // Validate optional vector override; bad shape just falls through to picker.
  let vectorOverride: VectorOverride | null = null;
  if (body.vectorOverride && typeof body.vectorOverride.topic === 'string'
      && body.vectorOverride.topic.trim()) {
    const m = body.vectorOverride.mode;
    if (m === 'depth' || m === 'granular' || m === 'fresh') {
      vectorOverride = {
        topic: body.vectorOverride.topic.trim(),
        mode: m,
        freshness_window: body.vectorOverride.freshness_window?.trim() || undefined,
      };
    }
  }
  const forceSerendipity = body.forceSerendipity === true;

  if (body.autoStart !== false) {
    const replyFn = makeReplyFn({ id: surfConvId, user_id: user.id });
    const controller = new AbortController();
    activeSurfs.set(surfConvId, controller);
    if (sourceConvId) surfsByMessageConv.set(sourceConvId, surfConvId);
    runSurf({
      surfConvId, sourceConvId, replyFn,
      signal: controller.signal, trigger: 'panel',
      vectorOverride, forceSerendipity,
    }).catch(e => console.error('[surf-api] error:', e));
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
  assertFeatureType(conv, 'surf');
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
  const user = findUser(c);
  if (!user) return c.json([]);
  return c.json(listConversationsByUser(user.id, 'message'));
});

// SSE for live log lines (every emit() in searcher.ts streams here).
surfRoutes.get('/events', (c) => sseStream(surfEvents, c.req.raw.signal, () => ({
  // Active surf conv ids + the message convs they're bound to. The
  // chat-header surf button uses sources to know when to show busy.
  active: Array.from(activeSurfs.keys()),
  sources: Array.from(surfsByMessageConv.keys()),
})));
