import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listConversationsByUser, getMessages,
  findConversation, findConversationById, createConversation, findMessageById,
  resetConversation, deleteMessage, deleteConversation, updateConversationTitle,
  getAttachmentsForMessages,
} from '../db/queries';
import { unlinkAttachmentFiles } from '../core/attachments';
import { regenerateConversation } from '../core/regenerate';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';
import { findUser, getOrCreateUser } from './_helpers';

export const chatApiRoutes = new Hono();

// List the caller's conversations. `?feature=message|surf|review|debate|portrait`
// filters to one tab; missing filter returns all (legacy / debug).
chatApiRoutes.get('/conversations', (c) => {
  const user = findUser(c);
  const feature = c.req.query('feature') || undefined;
  return c.json(listConversationsByUser(user.id, feature));
});

// Create a new conversation owned by the caller.
chatApiRoutes.post('/conversations', async (c) => {
  const user = getOrCreateUser(c);
  const { botId, title, featureType } = await c.req.json<{
    botId: string; title?: string;
    featureType?: 'message' | 'surf' | 'review' | 'debate' | 'portrait';
  }>();
  if (!botId) return c.json({ error: 'botId required' }, 400);

  const id = randomUUID();
  createConversation(id, botId, user.id, title ?? null, featureType ?? 'message');
  return c.json(findConversationById(id));
});

// Owner check helper. Throws (returning the response) if conv doesn't exist
// or belongs to someone else. Lets handlers focus on the happy path.
function assertOwnedConv(c: any, convId: string) {
  const user = findUser(c);
  const conv = findConversationById(convId);
  if (!conv) return { error: c.json({ error: 'not found' }, 404), conv: null, user };
  if (conv.user_id !== user.id) {
    return { error: c.json({ error: 'not found' }, 404), conv: null, user };
  }
  return { error: null, conv, user };
}

// Rename conversation
chatApiRoutes.patch('/conversations/:id', async (c) => {
  const { error, conv } = assertOwnedConv(c, c.req.param('id'));
  if (error) return error;
  const { title } = await c.req.json<{ title: string }>();
  if (typeof title !== 'string') return c.json({ error: 'title required' }, 400);
  updateConversationTitle(conv!.id, title.trim());
  return c.json({ ok: true });
});

// Delete conversation
chatApiRoutes.delete('/conversations/:id', async (c) => {
  const { error, conv } = assertOwnedConv(c, c.req.param('id'));
  if (error) return error;
  const paths = deleteConversation(conv!.id);
  // Fire-and-forget — files are best-effort; DB is the source of truth.
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// Get conversation messages — hydrated with any attachments
chatApiRoutes.get('/conversations/:id/messages', (c) => {
  const { error, conv } = assertOwnedConv(c, c.req.param('id'));
  if (error) return error;
  const limit = parseInt(c.req.query('limit') ?? '50');
  const msgs = getMessages(conv!.id, limit);
  const attMap = getAttachmentsForMessages(msgs.map((m: any) => m.id));
  const out = msgs.map((m: any) => ({
    ...m,
    attachments: (attMap[m.id] ?? []).map(a => ({
      id: a.id,
      kind: a.kind,
      mime: a.mime,
      size: a.size,
      width: a.width,
      height: a.height,
      url: `/uploads/${a.id}`,
    })),
  }));
  return c.json(out);
});

// Reset conversation (clear messages + memory).
chatApiRoutes.post('/conversations/reset', async (c) => {
  const body = await c.req.json<{ conversationId?: string; botId?: string }>();
  const user = findUser(c);

  let convId = body.conversationId;
  if (!convId && body.botId) {
    const conv = findConversation(body.botId, user.id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    convId = conv.id;
  }
  if (!convId) return c.json({ error: 'conversationId required' }, 400);

  const conv = findConversationById(convId);
  if (!conv || conv.user_id !== user.id) {
    return c.json({ error: 'not found' }, 404);
  }

  const paths = resetConversation(convId);
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// Delete a single message — must belong to a conv the caller owns.
chatApiRoutes.delete('/messages/:id', (c) => {
  const id = c.req.param('id');
  const user = findUser(c);
  const msg = findMessageById(id);
  if (!msg) return c.json({ error: 'not found' }, 404);
  const conv = findConversationById(msg.conversation_id);
  if (!conv || conv.user_id !== user.id) return c.json({ error: 'not found' }, 404);
  const paths = deleteMessage(id);
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// Rewind to a user message and re-run from there. Replies stream back over
// the caller's WS connection — we look up the user's web external_id from
// auth rather than trusting a body field.
chatApiRoutes.post('/conversations/:id/regenerate', async (c) => {
  const convId = c.req.param('id');
  const { error, user } = assertOwnedConv(c, convId);
  if (error) return error;

  const body = await c.req.json<{
    messageId?: string;
    newContent?: string;
    edits?: Array<{ messageId: string; content: string }>;
  }>();

  const channelUserId = user.external_id ?? user.id;
  const replyFn = (msg: OutboundMessage) => {
    webChannel.send(channelUserId, msg).catch(e =>
      console.error('[regen] send error:', e)
    );
  };

  const result = await regenerateConversation({
    conversationId: convId,
    channel: 'web',
    channelUserId,
    messageId: body.messageId,
    newContent: body.newContent,
    edits: body.edits,
    replyFn,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status as any);
  return c.json(result);
});
