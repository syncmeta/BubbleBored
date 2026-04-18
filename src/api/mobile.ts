import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listBots, findBot,
  findUserByChannel, createUser,
  listConversationsByUser, findConversationById, createConversation,
  updateConversationTitle, deleteConversation,
  getMessages, resetConversation, deleteMessage,
  getAttachmentsForMessages, getAttachmentsForMessage,
  getAllMessagesAsc, updateConversationRound, updateMessageContent,
} from '../db/queries';
import { configManager } from '../config/loader';
import { getDb } from '../db/index';
import { unlinkAttachmentFiles } from '../core/attachments';
import { handleUserMessage, signalNewMessage } from '../core/orchestrator';
import { cancelPendingReview } from '../core/review';
import { iosChannel } from '../bus/channels/ios';
import type { OutboundMessage } from '../bus/types';

/**
 * Mobile-only REST surface. Separate from the web `/api/*` routes so that
 * iOS/Android evolve independently. All routes take a `userId` generated
 * client-side (stored in UserDefaults); the server auto-creates the user
 * on first call — mirrors how the router auto-creates on first inbound WS.
 */
export const mobileApiRoutes = new Hono();

const CHANNEL = 'ios';

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
  return c.json(listConversationsByUser(user.id));
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
// iOS mirror of the web `/api/conversations/:id/regenerate` route. Logic is
// kept in lockstep; the only difference is the channel (`ios` vs `web`) and
// the reply transport (`iosChannel` vs `webChannel`).
mobileApiRoutes.post('/conversations/:id/regenerate', async (c) => {
  const convId = c.req.param('id');
  const body = await c.req.json<{
    messageId?: string;
    userId?: string;
    newContent?: string;
    edits?: Array<{ messageId: string; content: string }>;
  }>();
  const { userId: channelUserId, edits } = body;
  let { messageId, newContent } = body;
  if (!channelUserId) return c.json({ error: 'userId required' }, 400);
  if (!messageId && (!edits || edits.length === 0)) {
    return c.json({ error: 'messageId or edits required' }, 400);
  }

  const conv = findConversationById(convId);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const user = findUserByChannel(CHANNEL, channelUserId);
  if (!user || user.id !== conv.user_id) {
    return c.json({ error: 'unauthorized' }, 403);
  }

  const all = getAllMessagesAsc(convId) as Array<{
    id: string; sender_type: string; sender_id: string; content: string;
  }>;
  const indexById = new Map(all.map((m, i) => [m.id, i]));

  if (edits && edits.length > 0) {
    let latestIdx = -1;
    let latestId: string | null = null;
    for (const e of edits) {
      if (!e?.messageId || typeof e.content !== 'string') {
        return c.json({ error: 'bad edit entry' }, 400);
      }
      const idx = indexById.get(e.messageId);
      if (idx === undefined) {
        return c.json({ error: `edit for unknown message ${e.messageId}` }, 400);
      }
      if (all[idx].sender_type !== 'user') {
        return c.json({ error: `cannot edit non-user message ${e.messageId}` }, 400);
      }
      updateMessageContent(e.messageId, e.content);
      all[idx].content = e.content;
      if (idx > latestIdx) {
        latestIdx = idx;
        latestId = e.messageId;
      }
    }
    if (latestId) {
      const existing = messageId ? indexById.get(messageId) ?? -1 : -1;
      if (existing < latestIdx) messageId = latestId;
    }
  }

  if (!messageId) return c.json({ error: 'messageId required' }, 400);
  const clickedIdx = indexById.get(messageId) ?? -1;
  if (clickedIdx < 0) return c.json({ error: 'message not found' }, 404);

  let triggerIdx = -1;
  if (all[clickedIdx].sender_type === 'user') {
    triggerIdx = clickedIdx;
  } else {
    for (let i = clickedIdx - 1; i >= 0; i--) {
      if (all[i].sender_type === 'user') { triggerIdx = i; break; }
    }
  }
  if (triggerIdx < 0) return c.json({ error: 'no user message to regenerate from' }, 400);
  const trigger = all[triggerIdx];

  let effectiveContent = trigger.content;
  if (!edits && typeof newContent === 'string' && newContent !== trigger.content) {
    updateMessageContent(trigger.id, newContent);
    effectiveContent = newContent;
  }

  const toDelete = all.slice(triggerIdx + 1);
  const paths: string[] = [];
  for (const m of toDelete) {
    paths.push(...deleteMessage(m.id));
  }
  unlinkAttachmentFiles(paths).catch(() => {});

  updateConversationRound(convId, conv.round_count, 'user');
  signalNewMessage(convId);
  cancelPendingReview(convId);

  const replyFn = (msg: OutboundMessage) => {
    iosChannel.send(channelUserId, msg).catch(e =>
      console.error('[mobile-regen] send error:', e)
    );
  };

  handleUserMessage({
    conversationId: convId,
    botId: conv.bot_id,
    userId: trigger.sender_id,
    mergedContent: effectiveContent,
    replyFn,
    regenerate: true,
  }).catch(e => {
    console.error('[mobile-regen] error:', e);
    replyFn({ type: 'error', conversationId: convId, content: '重新生成失败，稍后再试' });
  });

  const triggerAtts = getAttachmentsForMessage(trigger.id).map(a => ({
    id: a.id, mime: a.mime, url: `/uploads/${a.id}`,
  }));
  return c.json({
    ok: true,
    deletedCount: toDelete.length,
    triggerMessageId: trigger.id,
    attachments: triggerAtts,
  });
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
