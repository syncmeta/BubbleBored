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
  userMessage: string;
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

  for (const msg of history) {
    const role = msg.sender_type === 'user' ? 'user' as const : 'assistant' as const;
    // Only annotate user messages — annotating assistant messages causes the
    // model to mimic the pattern and emit time annotations in its own output.
    const textContent = role === 'user'
      ? annotateMessage(msg.content, msg.created_at, now)
      : msg.content;

    if (role !== 'user') {
      messages.push({ role, content: textContent });
      continue;
    }

    const atts = attMap[msg.id] ?? [];
    const images = atts.filter(a => a.kind === 'image');
    if (images.length === 0) {
      messages.push({ role, content: textContent });
      continue;
    }

    if (!inlineImageMsgIds.has(msg.id)) {
      // Older image-bearing message — drop pixels, keep a hint
      const hint = images.length === 1 ? '[图片]' : `[${images.length} 张图片]`;
      const combined = textContent ? `${textContent}\n${hint}` : hint;
      messages.push({ role, content: combined });
      continue;
    }

    // Recent enough — include as multimodal content parts
    const parts: ChatCompletionContentPart[] = [];
    if (textContent) parts.push({ type: 'text', text: textContent });
    for (const att of images) {
      const bytes = await readAttachmentFile(att);
      if (!bytes) {
        // File missing from disk but row exists — note it so the model
        // doesn't get confused about what was supposed to be there.
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

  // Add current user message. (Note: the just-inserted user row is already
  // in `history` above, so this duplicates the most recent turn — preserved
  // to match existing behavior; do not alter without a wider review.)
  messages.push({ role: 'user', content: params.userMessage });

  return messages;
}
