import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listConversationsByUser, getMessages,
  findUserByChannel, createUser,
  findConversation, findConversationById, createConversation,
  resetConversation, deleteMessage, deleteConversation, updateConversationTitle,
  getAttachmentsForMessages,
} from '../db/queries';
import { unlinkAttachmentFiles } from '../core/attachments';
import { regenerateConversation } from '../core/regenerate';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';

export const chatApiRoutes = new Hono();

// List user conversations. `?feature=message|surf|review|debate|portrait`
// filters to one tab; missing filter returns all (legacy / debug).
chatApiRoutes.get('/conversations', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const feature = c.req.query('feature') || undefined;
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, feature);
  return c.json(convs);
});

// Create a new conversation. `featureType` defaults to 'message' so the
// existing chat flow keeps working; debate / surf / review / portrait tabs
// pass their own feature.
chatApiRoutes.post('/conversations', async (c) => {
  const { userId, botId, title, featureType } = await c.req.json<{
    userId: string; botId: string; title?: string;
    featureType?: 'message' | 'surf' | 'review' | 'debate' | 'portrait';
  }>();
  if (!userId || !botId) return c.json({ error: 'userId and botId required' }, 400);

  // Auto-create web user if missing (mirrors router behavior)
  let user = findUserByChannel('web', userId);
  if (!user) {
    const newId = randomUUID();
    createUser(newId, 'web', userId, `User-${userId.slice(0, 6)}`);
    user = findUserByChannel('web', userId);
  }
  if (!user) return c.json({ error: 'user creation failed' }, 500);

  const id = randomUUID();
  createConversation(id, botId, user.id, title ?? null, featureType ?? 'message');
  const conv = findConversationById(id);
  return c.json(conv);
});

// Rename conversation
chatApiRoutes.patch('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const { title } = await c.req.json<{ title: string }>();
  if (typeof title !== 'string') return c.json({ error: 'title required' }, 400);
  updateConversationTitle(id, title.trim());
  return c.json({ ok: true });
});

// Delete conversation
chatApiRoutes.delete('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const paths = deleteConversation(id);
  // Fire-and-forget — files are best-effort; DB is the source of truth.
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// Get conversation messages — hydrated with any attachments
chatApiRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') ?? '50');
  const msgs = getMessages(id, limit);
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

// Reset conversation (clear messages + memory)
// Accepts either { conversationId } (preferred) or legacy { userId, botId }.
chatApiRoutes.post('/conversations/reset', async (c) => {
  const body = await c.req.json<{ conversationId?: string; userId?: string; botId?: string }>();

  let convId = body.conversationId;
  if (!convId && body.userId && body.botId) {
    const user = findUserByChannel('web', body.userId);
    if (!user) return c.json({ error: 'user not found' }, 404);
    const conv = findConversation(body.botId, user.id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    convId = conv.id;
  }
  if (!convId) return c.json({ error: 'conversationId required' }, 400);

  const paths = resetConversation(convId);
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// Delete a single message
chatApiRoutes.delete('/messages/:id', (c) => {
  const id = c.req.param('id');
  const paths = deleteMessage(id);
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// Rewind to a user message and re-run from there. Semantically: "pretend
// I just sent this message" — everything after it gets deleted, then the
// LLM re-answers. Replies stream back over the WS tied to `userId`.
chatApiRoutes.post('/conversations/:id/regenerate', async (c) => {
  const convId = c.req.param('id');
  const body = await c.req.json<{
    messageId?: string;
    userId?: string;
    newContent?: string;
    edits?: Array<{ messageId: string; content: string }>;
  }>();
  const { userId: channelUserId } = body;

  const replyFn = (msg: OutboundMessage) => {
    if (channelUserId) {
      webChannel.send(channelUserId, msg).catch(e =>
        console.error('[regen] send error:', e)
      );
    }
  };

  const result = await regenerateConversation({
    conversationId: convId,
    channel: 'web',
    channelUserId: channelUserId ?? '',
    messageId: body.messageId,
    newContent: body.newContent,
    edits: body.edits,
    replyFn,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status as any);
  return c.json(result);
});
