import { Hono } from 'hono';
import { listConversationsByUser, getMessages, findUserByChannel } from '../db/queries';

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
