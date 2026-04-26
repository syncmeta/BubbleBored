import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  createConversation, findConversationById, deleteConversation,
  getMessages, listConversationsByUser,
  createDebateSettings, getDebateSettings,
} from '../db/queries';
import { runDebateRound, injectClarification, debateEvents, requestPause } from '../core/debate/orchestrator';
import {
  makeReplyFn, getOrCreateUser, findUser, resolveBotId, sseStream, assertFeatureType,
} from './_helpers';

export const debateRoutes = new Hono();

// ── Debate conversations ──

// List debate convs for a user (used to populate the 议论 tab list).
debateRoutes.get('/conversations', (c) => {
  const user = findUser(c);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, 'debate');
  // Hydrate with debate_settings so the UI can show topic + model count.
  const out = convs.map((conv: any) => {
    const settings = getDebateSettings(conv.id);
    return {
      ...conv,
      topic: settings?.topic ?? null,
      model_slugs: settings ? JSON.parse(settings.model_slugs) : [],
      round_count_debate: settings?.round_count ?? 0,
    };
  });
  return c.json(out);
});

debateRoutes.post('/conversations', async (c) => {
  const body = await c.req.json<{
    botId?: string; topic?: string; modelSlugs: string[];
  }>();
  if (!Array.isArray(body.modelSlugs) || body.modelSlugs.length < 2) {
    return c.json({ error: 'need at least 2 modelSlugs' }, 400);
  }

  const user = getOrCreateUser(c);
  // Debate doesn't really "belong" to a bot, but it does pull source context
  // from a (bot, user) message conv — pass the explicit one or fall back.
  const botId = resolveBotId({ explicit: body.botId });

  const id = randomUUID();
  const title = body.topic?.trim() || '议论';
  createConversation(id, botId, user.id, title, 'debate');
  createDebateSettings(id, body.modelSlugs, body.topic?.trim() || null);

  return c.json({ id, botId, topic: body.topic ?? null, modelSlugs: body.modelSlugs });
});

debateRoutes.delete('/conversations/:id', (c) => {
  const id = c.req.param('id');
  deleteConversation(id);
  return c.json({ ok: true });
});

// Messages for a debate conversation. Same shape as chat history but with
// the sender_kind passed through so the UI can render different bubbles.
debateRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  const msgs = getMessages(id, 200);
  return c.json(msgs);
});

debateRoutes.get('/conversations/:id', (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');
  const settings = getDebateSettings(id);
  return c.json({
    ...conv,
    topic: settings?.topic ?? null,
    model_slugs: settings ? JSON.parse(settings.model_slugs) : [],
    round_count_debate: settings?.round_count ?? 0,
  });
});

// Run one round
debateRoutes.post('/round/:convId', async (c) => {
  const conv = findConversationById(c.req.param('convId'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');

  let maxMessages: number | undefined;
  try {
    const body = await c.req.json<{ maxMessages?: number }>();
    if (typeof body?.maxMessages === 'number') maxMessages = body.maxMessages;
  } catch {}

  const replyFn = makeReplyFn(conv);

  // Fire-and-forget so HTTP returns fast; client gets the messages over WS +
  // SSE log stream. Errors surface on the SSE log channel.
  runDebateRound(conv.id, replyFn, { maxMessages }).catch(e => {
    console.error('[debate] error:', e);
    debateEvents.emit('log', {
      conversationId: conv.id, kind: 'error',
      content: `Round failed: ${e?.message ?? e}`, timestamp: Date.now(),
    });
  });

  return c.json({ ok: true });
});

// Pause an in-flight round. The orchestrator finishes the message currently
// being generated, then stops before picking the next model.
debateRoutes.post('/pause/:convId', (c) => {
  const conv = findConversationById(c.req.param('convId'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');
  requestPause(conv.id);
  return c.json({ ok: true });
});

// User clarification injection ("辟谣"). Stored as a user message with a
// small marker; the orchestrator will surface it as <用户辟谣> on the next round.
debateRoutes.post('/inject/:convId', async (c) => {
  const conv = findConversationById(c.req.param('convId'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');

  const body = await c.req.json<{ content: string; autoRound?: boolean; maxMessages?: number }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content required' }, 400);

  const messageId = injectClarification(conv.id, content);

  // Push the injection back to the client too so the bubble lands in real time.
  const replyFn = makeReplyFn(conv);
  replyFn({
    type: 'message',
    conversationId: conv.id,
    messageId,
    content,
    metadata: { sender_kind: 'clarify' },
  });

  if (body.autoRound !== false) {
    runDebateRound(conv.id, replyFn, { maxMessages: body.maxMessages }).catch(e => {
      console.error('[debate] error:', e);
      debateEvents.emit('log', {
        conversationId: conv.id, kind: 'error',
        content: `Auto-round failed: ${e?.message ?? e}`, timestamp: Date.now(),
      });
    });
  }
  return c.json({ ok: true, messageId });
});

// SSE for the debate log channel (status / errors / round-done).
debateRoutes.get('/events', (c) => sseStream(debateEvents, c.req.raw.signal));
