import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  listConversationsByUser, getMessages, getAllMessagesAsc,
  findUserByChannel, createUser,
  findConversation, findConversationById, createConversation,
  resetConversation, deleteMessage, deleteConversation, updateConversationTitle,
  getAttachmentsForMessages, getAttachmentsForMessage,
  updateConversationRound, updateMessageContent,
} from '../db/queries';
import { unlinkAttachmentFiles } from '../core/attachments';
import { handleUserMessage, signalNewMessage } from '../core/orchestrator';
import { cancelPendingReview } from '../core/review';
import { webChannel } from '../bus/channels/web';
import type { OutboundMessage } from '../bus/types';

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

// Create a new conversation (web only — multi-conversation feature)
chatApiRoutes.post('/conversations', async (c) => {
  const { userId, botId, title } = await c.req.json<{ userId: string; botId: string; title?: string }>();
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
  createConversation(id, botId, user.id, title ?? null);
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
//
// Accepts either a user messageId directly, or a bot messageId (for back-
// compat); a bot id is resolved to its preceding user message.
chatApiRoutes.post('/conversations/:id/regenerate', async (c) => {
  const convId = c.req.param('id');
  const body = await c.req.json<{
    messageId?: string;
    userId?: string;
    // Single-message edit path: overwrite the trigger message's text before
    // regenerating. Used by the "重来" button (no newContent) and by the
    // single-bubble edit path.
    newContent?: string;
    // Multi-bubble edit path: apply each content update, then treat the
    // latest edited user message as the regen anchor. `messageId` is
    // optional when `edits` is provided.
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

  const user = findUserByChannel('web', channelUserId);
  if (!user || user.id !== conv.user_id) {
    return c.json({ error: 'unauthorized' }, 403);
  }

  const all = getAllMessagesAsc(convId) as Array<{
    id: string; sender_type: string; sender_id: string; content: string;
  }>;
  const indexById = new Map(all.map((m, i) => [m.id, i]));

  // If the client sent a multi-bubble `edits` array, apply each content
  // update in-place AND derive the anchor = the edit whose message sits
  // latest in conversation order. All ids must belong to this conversation
  // and be user messages.
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
      all[idx].content = e.content; // keep local copy in sync
      if (idx > latestIdx) {
        latestIdx = idx;
        latestId = e.messageId;
      }
    }
    // If caller also passed messageId, prefer it only if it's strictly
    // later than the latest edit. Otherwise the latest edit becomes the
    // anchor (that's what the user's "click 完成" intent maps to).
    if (latestId) {
      const existing = messageId ? indexById.get(messageId) ?? -1 : -1;
      if (existing < latestIdx) messageId = latestId;
    }
  }

  if (!messageId) {
    return c.json({ error: 'messageId required' }, 400);
  }
  const clickedIdx = indexById.get(messageId) ?? -1;
  if (clickedIdx < 0) return c.json({ error: 'message not found' }, 404);

  // Resolve trigger = the user message the regeneration anchors on.
  // - Clicked user message → that's the trigger.
  // - Clicked bot message → walk back to its preceding user message.
  let triggerIdx = -1;
  if (all[clickedIdx].sender_type === 'user') {
    triggerIdx = clickedIdx;
  } else {
    for (let i = clickedIdx - 1; i >= 0; i--) {
      if (all[i].sender_type === 'user') { triggerIdx = i; break; }
    }
  }
  if (triggerIdx < 0) {
    return c.json({ error: 'no user message to regenerate from' }, 400);
  }
  const trigger = all[triggerIdx];

  // Single-message edit path (legacy / 重来 button). Skipped when the
  // `edits` array path already handled updates above.
  let effectiveContent = trigger.content;
  if (!edits && typeof newContent === 'string' && newContent !== trigger.content) {
    updateMessageContent(trigger.id, newContent);
    effectiveContent = newContent;
  }

  // Delete everything after the trigger user message. This drops the stale
  // bot turn and any later exchanges — the user is rewinding to that point.
  const toDelete = all.slice(triggerIdx + 1);
  const paths: string[] = [];
  for (const m of toDelete) {
    paths.push(...deleteMessage(m.id));
  }
  unlinkAttachmentFiles(paths).catch(() => {});

  // Restore conv state: last_sender='user' (since the bot reply is gone),
  // round_count stays where it was — regenerate replaces a round, not a new one.
  updateConversationRound(convId, conv.round_count, 'user');

  // Cancel anything mid-flight on this conversation.
  signalNewMessage(convId);
  cancelPendingReview(convId);

  const replyFn = (msg: OutboundMessage) => {
    webChannel.send(channelUserId, msg).catch(e =>
      console.error('[regen] send error:', e)
    );
  };

  // Kick off regeneration — fire-and-forget so the HTTP response returns
  // immediately; bot segments stream in over WS just like a normal send.
  handleUserMessage({
    conversationId: convId,
    botId: conv.bot_id,
    userId: trigger.sender_id,
    // Regenerate doesn't insert new rows; the DB row for `trigger` is already
    // the user message being re-run. Provide a single no-op entry for logging.
    userMessages: [{ content: effectiveContent }],
    replyFn,
    regenerate: true,
  }).catch(e => {
    console.error('[regen] error:', e);
    replyFn({ type: 'error', conversationId: convId, content: '重新生成失败，稍后再试' });
  });

  // Echo back the remaining-attachments snapshot so the client doesn't have
  // to guess at what was kept (nice-to-have for debugging; tiny payload).
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
