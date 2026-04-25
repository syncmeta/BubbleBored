import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listBots, findBot,
  findUserByChannel, createUser,
  listConversationsByUser, findConversationById, createConversation,
  updateConversationTitle, deleteConversation,
  getMessages, resetConversation, deleteMessage,
  getAttachmentsForMessages,
} from '../db/queries';
import { configManager } from '../config/loader';
import { getDb } from '../db/index';
import { unlinkAttachmentFiles } from '../core/attachments';
import { regenerateConversation } from '../core/regenerate';
import { iosChannel } from '../bus/channels/ios';
import type { OutboundMessage } from '../bus/types';

/**
 * Mobile-only REST surface. Separate from the web `/api/*` routes so that
 * iOS/Android evolve independently. All routes take a `userId` generated
 * client-side (stored in UserDefaults); the server auto-creates the user
 * on first call — mirrors how the router auto-creates on first inbound WS.
 */
export const mobileApiRoutes = new Hono();

const CHANNEL = 'ios' as const;

// Ensure an ios-channel user exists for the given client-generated id.
// Returns the internal user.id.
function ensureUser(channelUserId: string, displayName?: string): string {
  let user = findUserByChannel(CHANNEL, channelUserId);
  if (!user) {
    const id = randomUUID();
    createUser(id, CHANNEL, channelUserId, displayName ?? `iPhone-${channelUserId.slice(0, 6)}`);
    user = findUserByChannel(CHANNEL, channelUserId);
  }
  if (!user) throw new Error('user creation failed');
  return user.id;
}

// ── Health ──────────────────────────────────────────────────────────────────

mobileApiRoutes.get('/health', (c) => c.json({
  ok: true,
  service: 'bubblebored-mobile',
  ts: Math.floor(Date.now() / 1000),
}));

// ── Bots ────────────────────────────────────────────────────────────────────

// Returns only public-facing bot info (id, display_name). Full config stays
// server-side — iOS doesn't need model names / prompts etc.
mobileApiRoutes.get('/bots', (c) => {
  const bots = listBots();
  const out = bots.map((b: any) => {
    let accessMode: string | undefined;
    try { accessMode = configManager.getBotConfig(b.id).accessMode; } catch { /* ignore */ }
    return {
      id: b.id,
      display_name: b.display_name,
      access_mode: accessMode,
    };
  });
  return c.json(out);
});

// ── Conversations ───────────────────────────────────────────────────────────

mobileApiRoutes.get('/conversations', (c) => {
  const channelUserId = c.req.query('userId');
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  const user = findUserByChannel(CHANNEL, channelUserId);
  if (!user) return c.json([]);
  return c.json(listConversationsByUser(user.id, 'message'));
});

mobileApiRoutes.post('/conversations', async (c) => {
  const { userId, botId, title } = await c.req.json<{ userId: string; botId: string; title?: string }>();
  if (!userId || !botId) return c.json({ error: 'userId and botId required' }, 400);
  if (!findBot(botId)) return c.json({ error: 'bot not found' }, 404);

  const uid = ensureUser(userId);
  const id = randomUUID();
  createConversation(id, botId, uid, title ?? null);
  return c.json(findConversationById(id));
});

mobileApiRoutes.patch('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const { title } = await c.req.json<{ title: string }>();
  if (typeof title !== 'string') return c.json({ error: 'title required' }, 400);
  updateConversationTitle(id, title.trim());
  return c.json({ ok: true });
});

mobileApiRoutes.delete('/conversations/:id', (c) => {
  const paths = deleteConversation(c.req.param('id'));
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

mobileApiRoutes.get('/conversations/:id/messages', (c) => {
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

mobileApiRoutes.post('/conversations/reset', async (c) => {
  const { conversationId } = await c.req.json<{ conversationId?: string }>();
  if (!conversationId) return c.json({ error: 'conversationId required' }, 400);
  const paths = resetConversation(conversationId);
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

mobileApiRoutes.delete('/messages/:id', (c) => {
  const paths = deleteMessage(c.req.param('id'));
  unlinkAttachmentFiles(paths).catch(() => {});
  return c.json({ ok: true });
});

// ── Regenerate / edit ───────────────────────────────────────────────────────
mobileApiRoutes.post('/conversations/:id/regenerate', async (c) => {
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
      iosChannel.send(channelUserId, msg).catch(e =>
        console.error('[mobile-regen] send error:', e)
      );
    }
  };

  const result = await regenerateConversation({
    conversationId: convId,
    channel: CHANNEL,
    channelUserId: channelUserId ?? '',
    messageId: body.messageId,
    newContent: body.newContent,
    edits: body.edits,
    replyFn,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status as any);
  return c.json(result);
});

// ── Push (Phase 2 prep) ─────────────────────────────────────────────────────
// These routes exist now so the iOS client can ship stable code. When APNs is
// wired up, the token we store here will drive real pushes; until then we just
// record it.

mobileApiRoutes.post('/push/register', async (c) => {
  const { userId, deviceToken, bundleId, environment } = await c.req.json<{
    userId: string;
    deviceToken: string;
    bundleId?: string;
    environment?: 'sandbox' | 'production';
  }>();
  if (!userId || !deviceToken) return c.json({ error: 'userId and deviceToken required' }, 400);

  const uid = ensureUser(userId);
  getDb().query(
    `INSERT INTO device_tokens (user_id, device_token, bundle_id, environment, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(device_token) DO UPDATE SET
       user_id = excluded.user_id,
       bundle_id = excluded.bundle_id,
       environment = excluded.environment,
       updated_at = excluded.updated_at`
  ).run(uid, deviceToken, bundleId ?? null, environment ?? 'sandbox');

  return c.json({ ok: true });
});

mobileApiRoutes.post('/push/unregister', async (c) => {
  const { deviceToken } = await c.req.json<{ deviceToken: string }>();
  if (!deviceToken) return c.json({ error: 'deviceToken required' }, 400);
  getDb().query('DELETE FROM device_tokens WHERE device_token = ?').run(deviceToken);
  return c.json({ ok: true });
});
