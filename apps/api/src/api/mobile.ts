import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listBots, findBot,
  listConversationsByUser, findConversationById, createConversation,
  updateConversationTitle, setConversationModelOverride, deleteConversation,
  getMessages, resetConversation, deleteMessage,
  getAttachmentsForMessages,
  getUserBotModel, setUserBotModel,
} from '../db/queries';
import { configManager } from '../config/loader';
import { getDb } from '../db/index';
import { unlinkAttachmentFiles } from '../core/attachments';
import { regenerateConversation } from '../core/regenerate';
import { iosChannel } from '../bus/channels/ios';
import type { OutboundMessage } from '../bus/types';
import { requireAuthMiddleware } from './_helpers';
import { handleUserMessage } from '../core/orchestrator';
import { runWithUser } from '../core/request-context';

/**
 * Mobile-only REST surface. Auth is enforced by `requireAuthMiddleware` —
 * every route here expects `Authorization: Bearer <api_key>` and reads the
 * resolved user from `c.get('authUser')`. The previous client-supplied
 * userId param is ignored (and intentionally not trusted).
 *
 * /health is exempt so the iOS app can probe a server URL before it has
 * a key, e.g. on the manual-entry screen.
 */
export const mobileApiRoutes = new Hono();

const CHANNEL = 'ios' as const;

// ── Health (unauthenticated) ────────────────────────────────────────────────

mobileApiRoutes.get('/health', (c) => c.json({
  ok: true,
  service: 'bubblebored-mobile',
  ts: Math.floor(Date.now() / 1000),
}));

// Everything below requires a valid api key.
mobileApiRoutes.use('*', requireAuthMiddleware);

// ── Bots ────────────────────────────────────────────────────────────────────

// Returns public-facing bot info (id, display_name, model). `model` is the
// resolved per-user model — the user's per-bot override if set, otherwise
// the bot's config default. `user_model` carries the raw override (or null)
// so the UI can show "跟随机器人默认" vs an explicit pick. `default_model`
// is the bot's own default, used by the bot-management screen to label what
// "follow default" actually means.
mobileApiRoutes.get('/bots', (c) => {
  const user = c.get('authUser');
  const bots = listBots();
  const out = bots.map((b: any) => {
    let accessMode: string | undefined;
    let defaultModel: string | undefined;
    try {
      const cfg = configManager.getBotConfig(b.id);
      accessMode = cfg.accessMode;
      defaultModel = cfg.model;
    } catch { /* ignore */ }
    const userModel = getUserBotModel(user.id, b.id);
    return {
      id: b.id,
      display_name: b.display_name,
      access_mode: accessMode,
      model: userModel ?? defaultModel,
      default_model: defaultModel,
      user_model: userModel,
    };
  });
  return c.json(out);
});

// Per-user-per-bot model override. PATCH with { model: "<slug>" } to pin,
// { model: null } (or empty string) to clear and fall back to the bot's
// default. The override is scoped to the calling user only — no cross-user
// effect — and never touches the bot config on disk.
mobileApiRoutes.patch('/bots/:id', async (c) => {
  const user = c.get('authUser');
  const botId = c.req.param('id');
  if (!findBot(botId)) return c.json({ error: 'bot not found' }, 404);
  const body = await c.req.json<{ model?: string | null }>();
  if (body.model === undefined) {
    return c.json({ error: 'model field required (string or null)' }, 400);
  }
  const slug = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : null;
  setUserBotModel(user.id, botId, slug);
  return c.json({ ok: true, user_model: slug });
});

// Convenience: who am I? Lets the app show "logged in as <name>" in settings.
mobileApiRoutes.get('/me', (c) => {
  const user = c.get('authUser');
  return c.json({
    user_id: user.id,
    display_name: user.display_name,
  });
});

// ── Conversations ───────────────────────────────────────────────────────────

mobileApiRoutes.get('/conversations', (c) => {
  const user = c.get('authUser');
  return c.json(listConversationsByUser(user.id, 'message'));
});

mobileApiRoutes.post('/conversations', async (c) => {
  const user = c.get('authUser');
  const { botId, title } = await c.req.json<{ botId: string; title?: string }>();
  if (!botId) return c.json({ error: 'botId required' }, 400);
  if (!findBot(botId)) return c.json({ error: 'bot not found' }, 404);

  const id = randomUUID();
  createConversation(id, botId, user.id, title ?? null);

  // Fire-and-forget silent kickoff so the bot has a chance to greet the
  // brand-new conversation. The note is delivered to the model as a one-off
  // user-role message; orchestrator's `silent: true` skips DB persistence
  // and Honcho writes for the prompt itself, while the bot's reply (if any)
  // goes through the normal segment-insertion path. If no client is on the
  // ws yet, replyFn is a no-op — the reply still lands in DB and shows up
  // when the user opens the conversation.
  const replyFn = (msg: OutboundMessage) => {
    iosChannel.send(user.id, msg).catch(() => {});
  };
  const KICKOFF = '用户刚刚新建了一个与你的会话。此消息为系统发送，用户不可见。你可说些什么，也可以什么都不说。';
  runWithUser(user.id, () =>
    handleUserMessage({
      conversationId: id,
      botId,
      userId: user.id,
      userMessages: [{ content: KICKOFF }],
      replyFn,
      silent: true,
    })
  ).catch(e => console.warn('[mobile] kickoff failed:', e));

  return c.json(findConversationById(id));
});

mobileApiRoutes.patch('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; modelOverride?: string | null }>();
  if (typeof body.title === 'string') {
    updateConversationTitle(id, body.title.trim());
  }
  if (body.modelOverride !== undefined) {
    const slug = typeof body.modelOverride === 'string' && body.modelOverride.trim()
      ? body.modelOverride.trim()
      : null;
    setConversationModelOverride(id, slug);
  }
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
  const user = c.get('authUser');
  const body = await c.req.json<{
    messageId?: string;
    newContent?: string;
    edits?: Array<{ messageId: string; content: string }>;
  }>();

  // The WS channel keys connections by external_id, so that's what we
  // pass to iosChannel.send and to the regenerate helper.
  const channelUserId = user.external_id;

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
  const user = c.get('authUser');
  const { deviceToken, bundleId, environment } = await c.req.json<{
    deviceToken: string;
    bundleId?: string;
    environment?: 'sandbox' | 'production';
  }>();
  if (!deviceToken) return c.json({ error: 'deviceToken required' }, 400);

  getDb().query(
    `INSERT INTO device_tokens (user_id, device_token, bundle_id, environment, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(device_token) DO UPDATE SET
       user_id = excluded.user_id,
       bundle_id = excluded.bundle_id,
       environment = excluded.environment,
       updated_at = excluded.updated_at`
  ).run(user.id, deviceToken, bundleId ?? null, environment ?? 'sandbox');

  return c.json({ ok: true });
});

mobileApiRoutes.post('/push/unregister', async (c) => {
  const { deviceToken } = await c.req.json<{ deviceToken: string }>();
  if (!deviceToken) return c.json({ error: 'deviceToken required' }, 400);
  getDb().query('DELETE FROM device_tokens WHERE device_token = ?').run(deviceToken);
  return c.json({ ok: true });
});
