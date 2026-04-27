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
} from '../core/surfing/searcher';
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
      source_message_conv_id: run?.source_message_conv_id ?? null,
      status: run?.status ?? 'unknown',
      cost_budget_usd: run?.cost_budget_usd ?? null,
      cost_used_usd: run?.cost_used_usd ?? 0,
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
    source_message_conv_id: run?.source_message_conv_id ?? null,
    status: run?.status ?? 'unknown',
    cost_budget_usd: run?.cost_budget_usd ?? null,
    cost_used_usd: run?.cost_used_usd ?? 0,
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
// `sourceMessageConversationId` is optional: when given, the agent pulls
// context from that message conv and the final message is also delivered
// there as a bot message.
surfRoutes.post('/conversations', async (c) => {
  const body = await c.req.json<{
    botId?: string;
    sourceMessageConversationId?: string;
    costBudgetUsd?: number;
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

  const costBudgetUsd = body.costBudgetUsd && body.costBudgetUsd > 0
    ? body.costBudgetUsd
    : configManager.getBotConfig(botId).surfing.costBudgetUsd;

  const surfConvId = createSurfConversation({
    botId, userId: user.id,
    sourceMessageConvId: sourceConvId,
    costBudgetUsd,
    title: body.title ?? null,
  });

  const surfConv = findConversationById(surfConvId);
  if (!surfConv) return c.json({ error: 'create failed' }, 500);

  if (body.autoStart !== false) {
    const replyFn = makeReplyFn({ id: surfConvId, user_id: user.id });
    const controller = new AbortController();
    activeSurfs.set(surfConvId, controller);
    if (sourceConvId) surfsByMessageConv.set(sourceConvId, surfConvId);
    runSurf({
      surfConvId, sourceConvId, replyFn,
      signal: controller.signal, trigger: 'panel',
    }).catch(e => console.error('[surf-api] error:', e));
  }

  return c.json({
    id: surfConvId,
    botId,
    sourceMessageConversationId: sourceConvId,
    costBudgetUsd,
  });
});

// Re-run an existing surf conversation. Useful when the user wants to refresh
// the same source without creating a new history.
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

// Source message conversations the user can pin a surf to. Filtered by bot
// when ?botId= is given (the modal picks bot first, then optionally anchors
// to one of that bot's conversations).
surfRoutes.get('/sources', (c) => {
  const user = findUser(c);
  if (!user) return c.json([]);
  const botId = c.req.query('botId');
  const all = listConversationsByUser(user.id, 'message');
  return c.json(botId ? all.filter((c: any) => c.bot_id === botId) : all);
});

// SSE for live log lines (every emit() in searcher.ts streams here).
surfRoutes.get('/events', (c) => sseStream(surfEvents, c.req.raw.signal, () => ({
  active: Array.from(activeSurfs.keys()),
  sources: Array.from(surfsByMessageConv.keys()),
})));
