import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  findUserByChannel, findUserById, createUser, findBot, listBots,
  createConversation, findConversationById, deleteConversation,
  getMessages, listConversationsByUser,
  createDebateSettings, getDebateSettings,
} from '../db/queries';
import { runDebateRound, injectClarification, debateEvents } from '../core/debate/orchestrator';
import { messageBus } from '../bus/router';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';

export const debateRoutes = new Hono();

// Resolve the right reply path for a conversation:
//  1. If a channel is currently bound (user spoke recently), use it directly.
//  2. Otherwise look up the user's external (channel-side) id from the DB
//     and address the web channel with that — using conv.user_id (internal
//     UUID) wouldn't match the WS connection key.
//  3. If neither works, drop silently (the conv just won't update live).
function makeWebReplyFn(conv: { id: string; user_id: string }) {
  const bound = messageBus.getReplyFn(conv.id);
  if (bound) return bound;
  const user = findUserById(conv.user_id);
  const externalId = user?.external_id ?? null;
  return (msg: OutboundMessage) => {
    if (externalId) {
      webChannel.send(externalId, msg).catch(() => {});
    }
  };
}

// ── Debate conversations ──

// List debate convs for a user (used to populate the 议论 tab list).
debateRoutes.get('/conversations', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
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
    userId: string; botId?: string; topic?: string; modelSlugs: string[];
  }>();
  if (!body.userId) return c.json({ error: 'userId required' }, 400);
  if (!Array.isArray(body.modelSlugs) || body.modelSlugs.length < 2) {
    return c.json({ error: 'need at least 2 modelSlugs' }, 400);
  }

  let user = findUserByChannel('web', body.userId);
  if (!user) {
    const newId = randomUUID();
    createUser(newId, 'web', body.userId, `User-${body.userId.slice(0, 6)}`);
    user = findUserByChannel('web', body.userId);
  }
  if (!user) return c.json({ error: 'user creation failed' }, 500);

  // botId is required to satisfy the conversations FK; default to the first
  // configured bot if not specified — debate doesn't really "belong" to a
  // bot, but it does pull source context from a (bot, user) message conv.
  let botId: string | undefined = body.botId;
  if (!botId) {
    const bots = listBots();
    if (bots.length === 0) return c.json({ error: 'no bots configured' }, 500);
    botId = bots[0].id as string;
  }
  if (!botId || !findBot(botId)) return c.json({ error: 'bot not found' }, 404);

  const id = randomUUID();
  const title = body.topic?.trim() || '议论';
  createConversation(id, botId!, user.id, title, 'debate');
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
  if (conv.feature_type !== 'debate') return c.json({ error: 'not a debate conv' }, 400);
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
  if (conv.feature_type !== 'debate') return c.json({ error: 'not a debate conv' }, 400);

  const replyFn = makeWebReplyFn(conv);

  // Fire-and-forget so HTTP returns fast; client gets the messages over WS +
  // SSE log stream. Errors surface on the SSE log channel.
  runDebateRound(conv.id, replyFn).catch(e => {
    console.error('[debate] error:', e);
    debateEvents.emit('log', {
      conversationId: conv.id, kind: 'error',
      content: `Round failed: ${e?.message ?? e}`, timestamp: Date.now(),
    });
  });

  return c.json({ ok: true });
});

// User clarification injection ("辟谣"). Stored as a user message with a
// small marker; the orchestrator will surface it as <用户辟谣> on the next round.
debateRoutes.post('/inject/:convId', async (c) => {
  const conv = findConversationById(c.req.param('convId'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.feature_type !== 'debate') return c.json({ error: 'not a debate conv' }, 400);

  const body = await c.req.json<{ content: string; autoRound?: boolean }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content required' }, 400);

  const messageId = injectClarification(conv.id, content);

  // Push the injection back to the client too so the bubble lands in real time.
  const replyFn = makeWebReplyFn(conv);
  replyFn({
    type: 'message',
    conversationId: conv.id,
    messageId,
    content,
    metadata: { sender_kind: 'clarify' },
  });

  if (body.autoRound !== false) {
    runDebateRound(conv.id, replyFn).catch(e => {
      console.error('[debate] error:', e);
    });
  }
  return c.json({ ok: true, messageId });
});

// SSE for the debate log channel (status / errors / round-done).
debateRoutes.get('/events', (c) => {
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
      debateEvents.on('log', onLog);
      debateEvents.on('done', onDone);
      send('init', {});
      c.req.raw.signal.addEventListener('abort', () => {
        debateEvents.off('log', onLog);
        debateEvents.off('done', onDone);
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
