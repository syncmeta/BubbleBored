import { configManager } from '../config/loader';
import { getMessages, getAttachmentsForMessages, findConversationById, type AttachmentRow } from '../db/queries';
import { annotateMessage } from './time';
import { readAttachmentFile } from './attachments';
import { getCachedPerceptionBlock, refreshPerceptionInBackground } from './perception';
import { buildSkillsPromptBlock } from './skills';
import { buildJournalPromptBlock } from './surfing/journal';
import { messageBus } from '../bus/router';
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources/chat/completions';

// External chat platforms expose only text — there's no冲浪/回顾/画像/辩论 UI,
// no image pipeline, no tab switching. Tell the bot so it doesn't promise
// things it can't do on the current channel, while still knowing those
// features exist on the web side if the user asks.
function buildChannelContextBlock(kind: string | null): string | null {
  if (kind !== 'telegram' && kind !== 'feishu') return null;
  const platform = kind === 'telegram' ? 'Telegram' : '飞书';
  return `## 当前接入渠道

你正在通过 **${platform}** 跟对方对话。在这个渠道里你的能力是受限的：

- 只能进行纯文字消息往来。对方发图片/语音/文件你都收不到（不要假装看到了）。
- PendingBot 在网页端还有这些功能，但这里**没有**：
  - **冲浪**：系统定期主动搜对方视野之外的内容、再让你自然带进对话
  - **回顾**：对一段时间内的对话做总结回看
  - **你（画像）**：系统对对方长期理解形成的画像
  - **辩论**：两个人格围绕一个话题对辩
- 如果对方问起"你还能做什么/有哪些功能"，你可以告诉他这些功能存在、在 PendingBot 网页端使用；但你**没法在这个渠道里替他启动它们**。
- 不要主动推销这些功能。普通聊天照常按你的风格进行就行。`;
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
