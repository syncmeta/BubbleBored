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
import type { OutboundMessage } from '../bus/types';

export const debateRoutes = new Hono();

// ── Debate conversations ──

// List debate convs for a user (used to populate the 议论 tab list).
debateRoutes.get('/conversations', (c) => {
  const user = findUser(c);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, 'debate');
  // Hydrate with debate_settings so the UI can show topic + bot count.
  const out = convs.map((conv: any) => {
    const settings = getDebateSettings(conv.id);
    return {
      ...conv,
      topic: settings?.topic ?? null,
      bot_ids: settings ? JSON.parse(settings.bot_ids) : [],
      round_count_debate: settings?.round_count ?? 0,
      max_messages: settings?.max_messages ?? null,
    };
  });
  return c.json(out);
});

debateRoutes.post('/conversations', async (c) => {
  const body = await c.req.json<{
    topic?: string; botIds: string[]; maxMessages?: number;
  }>();
  if (!Array.isArray(body.botIds) || body.botIds.length < 2) {
    return c.json({ error: 'need at least 2 botIds' }, 400);
  }

  const user = getOrCreateUser(c);
  // The conversations table requires a non-null bot_id; debate doesn't really
  // "belong" to one bot — each debater pulls its own (bot, user) context — so
  // we just stamp the first participant for FK purposes.
  const ownerBotId = resolveBotId({ explicit: body.botIds[0] });

  const id = randomUUID();
  // Title starts blank; the orchestrator generates one from the first round's
  // transcript using the same prompt as 消息 titles.
  createConversation(id, ownerBotId, user.id, '', 'debate');
  const maxMessages = Number.isFinite(body.maxMessages) && Number(body.maxMessages) > 0
    ? Math.min(Math.floor(Number(body.maxMessages)), 200)
    : null;
  createDebateSettings(id, body.botIds, body.topic?.trim() || null, maxMessages);

  const conv = findConversationById(id);
  const settings = getDebateSettings(id);
  return c.json({
    ...conv,
    topic: settings?.topic ?? null,
    bot_ids: settings ? JSON.parse(settings.bot_ids) : [],
    round_count_debate: settings?.round_count ?? 0,
    max_messages: settings?.max_messages ?? null,
  });
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
    bot_ids: settings ? JSON.parse(settings.bot_ids) : [],
    round_count_debate: settings?.round_count ?? 0,
    max_messages: settings?.max_messages ?? null,
  });
});

// Run one round. Streams each generated message back to the caller as an
// SSE `log` event whose data is the ChatMessage row. Web also reads this
// (its fetch just blocks until the round finishes); mobile parses the SSE
// directly. The web channel WS still receives the same messages so any
// other listeners (audit panes, etc.) keep working.
debateRoutes.post('/conversations/:id/round', async (c) => {
  const conv = findConversationById(c.req.param('id'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');

  let maxMessages: number | undefined;
  try {
    const body = await c.req.json<{ maxMessages?: number }>();
    if (typeof body?.maxMessages === 'number') maxMessages = body.maxMessages;
  } catch {}
  if (maxMessages === undefined) {
    const settings = getDebateSettings(conv.id);
    if (settings?.max_messages != null) maxMessages = settings.max_messages;
  }

  return streamingRound(conv, maxMessages);
});

// Pause an in-flight round. The orchestrator finishes the message currently
// being generated, then stops before picking the next model.
debateRoutes.post('/conversations/:id/pause', (c) => {
  const conv = findConversationById(c.req.param('id'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');
  requestPause(conv.id);
  return c.json({ ok: true });
});

// User clarification injection ("辟谣"). Stored as a user message with a
// small marker; the orchestrator will surface it as <用户辟谣> on the next round.
debateRoutes.post('/conversations/:id/clarify', async (c) => {
  const conv = findConversationById(c.req.param('id'));
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'debate');

  const body = await c.req.json<{ content: string; autoRound?: boolean; maxMessages?: number }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content required' }, 400);

  const messageId = injectClarification(conv.id, content);
  const clarifyMsg: OutboundMessage = {
    type: 'message',
    conversationId: conv.id,
    messageId,
    content,
    metadata: { sender_kind: 'clarify' },
  };

  // Mirror the clarification into the WS channel so any web listeners see it.
  makeReplyFn(conv)(clarifyMsg);

  if (body.autoRound === false) {
    return c.json({ ok: true, messageId });
  }

  let max = body.maxMessages;
  if (max === undefined) {
    const settings = getDebateSettings(conv.id);
    if (settings?.max_messages != null) max = settings.max_messages;
  }

  return streamingRound(conv, max, {
    initialMessage: { id: messageId, sender_type: 'user', sender_id: 'clarify', content },
  });
});

// SSE for the debate log channel (status / errors / round-done).
debateRoutes.get('/events', (c) => sseStream(debateEvents, c.req.raw.signal));

// Inline SSE response that drives one debate round and streams each
// generated message back as a `log` event with the same ChatMessage shape
// that GET /conversations/:id/messages returns. Used by both the round and
// auto-round-after-clarify endpoints. The WS reply path is preserved so any
// other listeners still receive their copy of each message.
function streamingRound(
  conv: { id: string; user_id: string },
  maxMessages: number | undefined,
  opts?: {
    initialMessage?: { id: string; sender_type: string; sender_id: string; content: string };
  },
): Response {
  const wsReply = makeReplyFn(conv);
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      const sendMessage = (m: {
        id: string; sender_type: string; sender_id: string; content: string;
      }) => send('log', {
        id: m.id,
        conversation_id: conv.id,
        sender_type: m.sender_type,
        sender_id: m.sender_id,
        content: m.content,
        created_at: Math.floor(Date.now() / 1000),
        attachments: null,
      });

      if (opts?.initialMessage) sendMessage(opts.initialMessage);

      const replyFn = (msg: OutboundMessage) => {
        wsReply(msg);
        const meta = msg.metadata ?? {};
        const senderType = (meta.sender_kind as string) ?? 'debater';
        const senderId = (meta.bot_id as string) ?? '';
        // Forward live stream events alongside the legacy `log` event so the
        // mobile SSE consumer can grow each debater's bubble in real time.
        // Web (which polls /messages after `done`) just ignores the new
        // event names and keeps working off `log`.
        if (msg.messageId && (msg.type === 'stream_start' || msg.type === 'stream_delta' || msg.type === 'stream_end')) {
          send(msg.type, {
            id: msg.messageId,
            sender_type: senderType,
            sender_id: senderId,
            ...(msg.delta != null ? { delta: msg.delta } : {}),
            ...(msg.content != null ? { content: msg.content } : {}),
          });
          return;
        }
        if (msg.type === 'message' && msg.messageId && msg.content) {
          sendMessage({
            id: msg.messageId,
            sender_type: senderType,
            sender_id: senderId,
            content: msg.content,
          });
        }
      };

      try {
        await runDebateRound(conv.id, replyFn, { maxMessages });
        send('done', {});
      } catch (e: any) {
        console.error('[debate] error:', e);
        debateEvents.emit('log', {
          conversationId: conv.id, kind: 'error',
          content: `Round failed: ${e?.message ?? e}`, timestamp: Date.now(),
        });
        send('error', { message: e?.message ?? String(e) });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
