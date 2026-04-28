import { configManager } from '../config/loader';
import { getMessages, getAttachmentsForMessages, findConversationById, getRecentBotReflections, type AttachmentRow } from '../db/queries';
import { annotateMessage } from './time';
import { readAttachmentFile } from './attachments';
import { getCachedPerceptionBlock, refreshPerceptionInBackground } from './perception';
import { buildSkillsPromptBlock } from './skills';
import { buildJournalPromptBlock } from './surfing/journal';
import { messageBus } from '../bus/router';
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources/chat/completions';

// Splice the bot's own self-reflections — accumulated across past 回顾 runs
// for THIS bot+user pair — into the system prompt so the bot literally
// carries its lessons forward into the next reply. Returns null if there's
// nothing yet (first conversation, no review run has saved anything).
function buildSelfReflectionBlock(botId: string, userId: string): string | null {
  const rows = getRecentBotReflections(botId, userId, 9);
  if (rows.length === 0) return null;
  const limits = rows.filter(r => r.kind === 'limit').map(r => r.content);
  const grows  = rows.filter(r => r.kind === 'grow').map(r => r.content);
  const keeps  = rows.filter(r => r.kind === 'keep').map(r => r.content);
  const sections: string[] = [];
  if (limits.length > 0) sections.push(`**要警惕的（自己的局限）**\n${limits.map(s => `- ${s}`).join('\n')}`);
  if (grows.length > 0)  sections.push(`**要继续发扬的**\n${grows.map(s => `- ${s}`).join('\n')}`);
  if (keeps.length > 0)  sections.push(`**要守住的**\n${keeps.map(s => `- ${s}`).join('\n')}`);
  if (sections.length === 0) return null;
  return [
    '## 你过往回顾时记下的心得',
    '',
    '这些是你以前跟这位用户聊过、自己复盘时记下来要带进每一次对话的东西。',
    '不用机械念出来，但行动上请遵循。',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

// Was: tell the bot when it's running on a text-only external channel
// (Telegram / Feishu). Those channels were removed in the monorepo
// restructure; web + iOS both render rich UI, so no per-channel block is
// needed. Stub kept (and called by buildPrompt) so callers stay stable.
function buildChannelContextBlock(_kind: string | null): string | null {
  return null;
}

// Only attach the N most recent image-bearing user messages inline; older
// ones degrade to a text placeholder. Keeps prompt payload bounded in long
// image-heavy conversations.
const IMAGE_CONTEXT_WINDOW = 4;

export type ChatTone = 'wechat' | 'normal';

export async function buildPrompt(params: {
  botId: string;
  conversationId: string;
  // Owner of the conversation. Used to load the user's enabled skills
  // (a per-user catalog managed in the 「我」 tab). Optional so non-chat
  // callers can omit it and skip skill injection — when missing we fall
  // back to looking it up from the conversation row.
  userId?: string;
  extraContext?: string;
  // 'wechat' (default): casual multi-bubble + [SILENT] protocol.
  // 'normal': straightforward AI assistant — single message, normal punctuation.
  tone?: ChatTone;
}): Promise<{ messages: ChatCompletionMessageParam[]; hasInlineImages: boolean }> {
  const botConfig = configManager.getBotConfig(params.botId);

  // Read prompts fresh (no cache). The "normal AI" tone swaps in a different
  // base prompt; the bot persona file is still appended on top either way so
  // the chosen 人格 stays consistent across tones.
  const systemFile = params.tone === 'normal' ? 'system-normal.md' : 'system.md';
  const systemPrompt = await configManager.readPrompt(systemFile);
  let botPrompt = '';
  try {
    botPrompt = await configManager.readPrompt(`bots/${botConfig.promptFile}`);
  } catch {
    // Bot prompt file not found, use empty
  }

  // Build system message
  let system = systemPrompt;
  if (botPrompt) {
    system += '\n\n' + botPrompt;
  }
  const channelBlock = buildChannelContextBlock(messageBus.getChannelKind(params.conversationId));
  if (channelBlock) {
    system += '\n\n' + channelBlock;
  }
  if (params.extraContext) {
    system += '\n\n' + params.extraContext;
  }

  // User-enabled skills (Anthropic-style Agent Skills) — appended after the
  // bot/channel/extra context so the bot's own persona stays primary and the
  // skills layer reads as ambient capability.
  const userId = params.userId
    ?? findConversationById(params.conversationId)?.user_id
    ?? null;
  if (userId) {
    const skillsBlock = buildSkillsPromptBlock(userId);
    if (skillsBlock) system += '\n\n' + skillsBlock;

    // Self-reflections from past 回顾 runs for this (bot, user) pair. Goes
    // after skills and before perception so the bot reads them as personal
    // resolutions, not ambient sensor data.
    const reflBlock = buildSelfReflectionBlock(params.botId, userId);
    if (reflBlock) system += '\n\n' + reflBlock;

    // Surfing journal — bot's own first-person experiences across conversations.
    // Lets the bot reference real things it has seen ("前几天我刷到一个东西…")
    // without us having to push them at the user.
    const journal = buildJournalPromptBlock(
      params.botId, userId, botConfig.surfing.journalEntriesInChat,
    );
    if (journal.block) system += '\n\n' + journal.block;
  }

  // Append the AI-generated perception block last so the model treats it as
  // ambient ground rather than primary instruction.
  //
  // Stale-while-revalidate: use whatever's already cached (instantaneous —
  // no LLM call on the prompt-build path) and kick a fresh recompute in the
  // background so the NEXT message has an up-to-date block. The first ever
  // message in a conv runs with no perception, which is fine — Bot still
  // has a usable system prompt and the user gets a fast first reply.
  const perception = getCachedPerceptionBlock(params.conversationId);
  if (perception) system += '\n\n' + perception;
  refreshPerceptionInBackground(params.conversationId);

  // Get history messages with time annotations
  const now = Math.floor(Date.now() / 1000);
  const history = getMessages(params.conversationId, 50);

  // Look up attachments for every user message in one batch.
  const userMsgIds = history.filter((m: any) => m.sender_type === 'user').map((m: any) => m.id);
  const attMap = getAttachmentsForMessages(userMsgIds);

  // Decide which user messages get to include their images inline: the
  // IMAGE_CONTEXT_WINDOW most recent ones. Older ones collapse to a
  // "[image]" placeholder so the model still knows something was sent.
  const imgBearingUserMsgs = history.filter((m: any) =>
    m.sender_type === 'user' && (attMap[m.id]?.some(a => a.kind === 'image') ?? false)
  );
  const inlineImageMsgIds = new Set(
    imgBearingUserMsgs.slice(-IMAGE_CONTEXT_WINDOW).map((m: any) => m.id as string)
  );

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  // Walk history and collapse consecutive same-role rows into one API
  // message. Storage keeps a row per user send; the LLM sees them joined so
  // it doesn't see weird alternating-user-only sequences and so a rapid-fire
  // trio ("yo", "quick q", "what's the best way to…") reads as one turn.
  let i = 0;
  while (i < history.length) {
    const first = history[i];
    const role = first.sender_type === 'user' ? 'user' as const : 'assistant' as const;

    // Collect the contiguous run of same-sender rows.
    const group: any[] = [];
    while (i < history.length && history[i].sender_type === first.sender_type) {
      group.push(history[i]);
      i++;
    }

    if (role === 'assistant') {
      // Bot messages are already stored per-segment; keep them split as
      // distinct assistant messages so the model sees its own segmenting
      // cadence rather than a single mashed-together blob.
      for (const m of group) {
        messages.push({ role, content: m.content });
      }
      continue;
    }

    // ── User run ──────────────────────────────────────────────────────
    // Build per-row rendered text (annotated) and classify image handling.
    type Rendered = { text: string; inlineImages: AttachmentRow[] };
    const rendered: Rendered[] = group.map(m => {
      const base = m.content ? annotateMessage(m.content, m.created_at, now) : '';
      const atts = attMap[m.id] ?? [];
      const images = atts.filter(a => a.kind === 'image');
      if (images.length === 0) {
        return { text: base, inlineImages: [] };
      }
      if (!inlineImageMsgIds.has(m.id)) {
        // Older image-bearing message — drop pixels, keep a hint.
        const hint = images.length === 1 ? '[图片]' : `[${images.length} 张图片]`;
        return { text: base ? `${base}\n${hint}` : hint, inlineImages: [] };
      }
      return { text: base, inlineImages: images };
    });

    // Messages and messages separated by \n\n — this is the "only merge at
    // LLM-request time" rule. Empty texts (image-only sends) don't contribute.
    const combinedText = rendered.map(r => r.text).filter(Boolean).join('\n\n');
    const allInlineImages = rendered.flatMap(r => r.inlineImages);

    if (allInlineImages.length === 0) {
      messages.push({ role, content: combinedText });
      continue;
    }

    // Multimodal: one text part (if any) followed by all inline images.
    const parts: ChatCompletionContentPart[] = [];
    if (combinedText) parts.push({ type: 'text', text: combinedText });
    for (const att of allInlineImages) {
      const bytes = await readAttachmentFile(att);
      if (!bytes) {
        parts.push({ type: 'text', text: '[图片缺失]' });
        continue;
      }
      const b64 = Buffer.from(bytes).toString('base64');
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${att.mime};base64,${b64}` },
      });
    }
    // OpenAI's schema requires non-empty array; guaranteed since we have ≥1 image.
    messages.push({ role, content: parts });
  }

  return { messages, hasInlineImages: inlineImageMsgIds.size > 0 };
}
