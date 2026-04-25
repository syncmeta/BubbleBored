import { configManager } from '../config/loader';
import { getMessages, getAttachmentsForMessages, type AttachmentRow } from '../db/queries';
import { annotateMessage } from './time';
import { readAttachmentFile } from './attachments';
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources/chat/completions';

// Only attach the N most recent image-bearing user messages inline; older
// ones degrade to a text placeholder. Keeps prompt payload bounded in long
// image-heavy conversations.
const IMAGE_CONTEXT_WINDOW = 4;

export async function buildPrompt(params: {
  botId: string;
  conversationId: string;
  extraContext?: string;
}): Promise<ChatCompletionMessageParam[]> {
  const botConfig = configManager.getBotConfig(params.botId);

  // Read prompts fresh (no cache)
  const systemPrompt = await configManager.readPrompt('system.md');
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
  if (params.extraContext) {
    system += '\n\n' + params.extraContext;
  }

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

  return messages;
}
