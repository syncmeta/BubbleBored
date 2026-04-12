import { Hono } from 'hono';
import { listConversationsByUser, getMessages, findUserByChannel, findConversation, resetConversation, deleteMessage } from '../db/queries';

export const chatApiRoutes = new Hono();

// List user conversations
chatApiRoutes.get('/conversations', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel('web', channelUserId);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id);
  return c.json(convs);
});

// Get conversation messages
chatApiRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') ?? '50');
  const msgs = getMessages(id, limit);
  return c.json(msgs);
});

// Reset conversation (clear messages + memory)
chatApiRoutes.post('/conversations/reset', async (c) => {
  const { userId, botId } = await c.req.json<{ userId: string; botId: string }>();
  if (!userId || !botId) return c.json({ error: 'userId and botId required' }, 400);
  const user = findUserByChannel('web', userId);
  if (!user) return c.json({ error: 'user not found' }, 404);
  const conv = findConversation(botId, user.id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  resetConversation(conv.id);
  return c.json({ ok: true });
});

// Delete a single message
chatApiRoutes.delete('/messages/:id', (c) => {
  const id = c.req.param('id');
  deleteMessage(id);
  return c.json({ ok: true });
});
