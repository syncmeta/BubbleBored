import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import {
  createConversation, findConversationById, deleteConversation,
  listConversationsByUser, getMessages, insertMessage,
  listPortraitsByConversation, deletePortrait,
  type PortraitKind,
} from '../db/queries';
import { generatePortrait } from '../core/portrait/generator';
import { configManager } from '../config/loader';
import { chatCompletion } from '../llm/client';
import { logAudit } from '../llm/audit';
import { modelFor } from '../core/models';
import { makeReplyFn, getOrCreateUser, findUser, assertFeatureType } from './_helpers';

export const portraitRoutes = new Hono();

const VALID_KINDS: ReadonlySet<PortraitKind> = new Set([
  'moments', 'memos', 'schedule', 'alarms', 'bills',
]);

// ── Source pickers ──

// Lists user's message conversations so the UI can let them pick a "source"
// to base a portrait on. Lightweight projection — chat list elsewhere covers
// full hydration.
portraitRoutes.get('/sources', (c) => {
  const user = findUser(c);
  if (!user) return c.json([]);
  return c.json(listConversationsByUser(user.id, 'message'));
});

// ── Portrait conversations ──

portraitRoutes.get('/conversations', (c) => {
  const user = findUser(c);
  if (!user) return c.json([]);
  const convs = listConversationsByUser(user.id, 'portrait');
  // Hydrate with a count of generated portraits per conv
  const out = convs.map((conv: any) => {
    const portraits = listPortraitsByConversation(conv.id);
    return {
      ...conv,
      portrait_count: portraits.length,
      kinds: Array.from(new Set(portraits.map(p => p.kind))),
    };
  });
  return c.json(out);
});

portraitRoutes.post('/conversations', async (c) => {
  const body = await c.req.json<{
    sourceConversationId: string;  // the message conv to base portraits on
    title?: string;
  }>();
  if (!body.sourceConversationId) return c.json({ error: 'sourceConversationId required' }, 400);

  const user = getOrCreateUser(c);

  const sourceConv = findConversationById(body.sourceConversationId);
  if (!sourceConv) return c.json({ error: 'source conversation not found' }, 404);
  if (sourceConv.user_id !== user.id) return c.json({ error: 'source conversation not found' }, 404);
  assertFeatureType(sourceConv, 'message');

  // Reuse the source conv's bot — the generator agent inherits that bot's
  // character/voice when the user chats inside the portrait thread.
  const id = randomUUID();
  const title = body.title?.trim() || `画像 · ${sourceConv.title?.trim() || '某会话'}`;
  createConversation(id, sourceConv.bot_id, user.id, title, 'portrait');

  // Stash the source conv id on a generated metadata message so the chat
  // route can recover it without a dedicated table just for the pointer.
  insertMessage(
    randomUUID(), id, 'system', '__portrait_source__', sourceConv.id,
  );

  return c.json({ id, sourceConversationId: sourceConv.id, title, botId: sourceConv.bot_id });
});

portraitRoutes.delete('/conversations/:id', (c) => {
  deleteConversation(c.req.param('id'));
  return c.json({ ok: true });
});

// Helper: read the stashed source-conv id off the system marker message.
function getPortraitSourceId(portraitConvId: string): string | null {
  const all = getMessages(portraitConvId, 200);
  const marker = all.find(m => m.sender_type === 'system' && m.sender_id === '__portrait_source__');
  return marker?.content ?? null;
}

portraitRoutes.get('/conversations/:id', (c) => {
  const id = c.req.param('id');
  const conv = findConversationById(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'portrait');

  const portraits = listPortraitsByConversation(id).map(p => ({
    ...p,
    content: tryParseJSON(p.content_json),
  }));
  return c.json({
    ...conv,
    sourceConversationId: getPortraitSourceId(id),
    portraits,
  });
});

// ── Generate a portrait asset ──

portraitRoutes.post('/generate/:convId', async (c) => {
  const portraitConvId = c.req.param('convId');
  const body = await c.req.json<{
    kind: PortraitKind; withImage?: boolean; model?: string;
  }>();
  if (!VALID_KINDS.has(body.kind)) return c.json({ error: 'invalid kind' }, 400);

  const conv = findConversationById(portraitConvId);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'portrait');

  const sourceId = getPortraitSourceId(portraitConvId);
  if (!sourceId) return c.json({ error: 'portrait has no source conversation' }, 500);

  try {
    const out = await generatePortrait({
      portraitConvId,
      sourceConversationId: sourceId,
      kind: body.kind,
      withImage: !!body.withImage,
      model: body.model?.trim() || undefined,
    });
    return c.json({ ok: true, portraitId: out.portraitId, content: out.content });
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'generation failed' }, 500);
  }
});

portraitRoutes.delete('/portraits/:id', (c) => {
  deletePortrait(c.req.param('id'));
  return c.json({ ok: true });
});

// ── Chat with the generator agent inside a portrait conv ──

// Synchronous reply — simpler than the WS chat flow because the portrait
// thread is tiny and self-contained (no debounce, no segments, no review).
portraitRoutes.post('/chat/:convId', async (c) => {
  const portraitConvId = c.req.param('convId');
  const body = await c.req.json<{ content: string }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'content required' }, 400);

  const conv = findConversationById(portraitConvId);
  if (!conv) return c.json({ error: 'not found' }, 404);
  assertFeatureType(conv, 'portrait');

  // Persist user message
  const userMsgId = randomUUID();
  insertMessage(userMsgId, portraitConvId, 'user', conv.user_id, content);

  // Build a transcript of the existing thread, plus a summary of the
  // portraits already generated (so the agent can refer to them in answers).
  const portraits = listPortraitsByConversation(portraitConvId);
  const portraitSummary = portraits.length === 0
    ? '（还没有生成任何画像）'
    : portraits.map(p => {
        const c = tryParseJSON(p.content_json);
        const items = Array.isArray(c?.items) ? c.items : [];
        return `· ${kindLabel(p.kind)}（${items.length} 条，${new Date(p.created_at * 1000).toLocaleString()}）`;
      }).join('\n');

  const allMsgs = getMessages(portraitConvId, 50)
    .filter(m => m.sender_type !== 'system');
  const history = allMsgs.map((m: any) => ({
    role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.content as string,
  }));

  const systemPrompt = await configManager.readPrompt('portrait/chat.md');
  const model = modelFor(conv.bot_id);

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: `已生成的画像清单：\n${portraitSummary}\n\n（以下是 ta 跟你的对话）` },
    ...history,
  ];

  const { result, latencyMs, costUsd } = await chatCompletion({ model, messages });
  logAudit({
    userId: conv.user_id,
    conversationId: portraitConvId, taskType: 'portrait', model,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    totalTokens: result.usage?.total_tokens ?? 0,
    costUsd, generationId: result.id, latencyMs,
  });

  const replyText = result.choices[0]?.message?.content?.trim() ?? '';
  const replyId = randomUUID();
  insertMessage(replyId, portraitConvId, 'bot', conv.bot_id, replyText);

  // Echo over WS too so the bubble shows up in real time if the user has
  // multiple tabs open.
  const replyFn = makeReplyFn(conv);
  replyFn({
    type: 'message',
    conversationId: portraitConvId,
    messageId: replyId,
    content: replyText,
    metadata: { sender_kind: 'portrait_chat' },
  });

  return c.json({ ok: true, userMessageId: userMsgId, replyId, reply: replyText });
});

portraitRoutes.get('/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  const msgs = getMessages(id, 200).filter(m => m.sender_type !== 'system');
  return c.json(msgs);
});

function tryParseJSON(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function kindLabel(kind: string): string {
  return ({
    moments: '朋友圈',
    memos: '备忘录',
    schedule: '日程',
    alarms: '闹钟',
    bills: '账单',
  } as Record<string, string>)[kind] ?? kind;
}
